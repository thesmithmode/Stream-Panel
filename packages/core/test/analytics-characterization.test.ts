import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import type Database from 'better-sqlite3';
import { StreamStore } from '../src/store.js';
import { audienceAnalytics, type AnalyticsOptions } from '../src/analytics.js';
import { InsightAccumulator, streamInsights } from '../src/insights.js';
import { syntheticProfile, SYNTHETIC_START, SYNTHETIC_END } from './synthetic-profile.js';

// Characterization of analytics, insights and ingestion on a rich synthetic profile. The golden
// hashes were produced by the implementation before the analytics/insights/ingestion split; any
// change in any output byte fails here. Regenerate only for an intended behavior change:
// STREAM_PANEL_WRITE_CHARACTERIZATION=1 node --test dist/packages/core/test/analytics-characterization.test.js
const golden = new URL('../../../../packages/core/test/fixtures/analytics-characterization.json', import.meta.url);
const stable = (value: unknown) =>
  JSON.stringify(value, (_key, x) =>
    x instanceof Map
      ? { map: [...x] }
      : x instanceof Set
        ? { set: [...x] }
        : typeof x === 'bigint'
          ? { bigint: String(x) }
          : x === undefined
            ? null
            : x,
  );
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');

test('analytics, insights and ingestion outputs match the recorded characterization', () => {
  const crypto = createRequire(import.meta.url)('node:crypto') as { randomUUID: () => string };
  const realUuid = crypto.randomUUID,
    realNow = Date.now;
  let uuid = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`;
  syncBuiltinESMExports();
  Date.now = () => SYNTHETIC_END;
  const store = new StreamStore(':memory:');
  try {
    const profile = syntheticProfile(store),
      reads = (store as unknown as { reads: Database.Database }).reads;
    const results: Record<string, string> = {};
    const run = (label: string, fn: () => unknown) => {
      let value: unknown;
      try {
        value = fn();
      } catch (error) {
        value = { error: (error as Error).message };
      }
      assert.equal(results[label], undefined, label);
      results[label] = hash(value);
      return value;
    };
    const settle = <T>(fn: () => T): T => {
      let value = fn();
      for (let i = 0; (value as { preparing?: boolean }).preparing === true; i++) {
        assert.ok(i < 100000, 'report never settled');
        value = fn();
      }
      return value;
    };
    const base = {
      excludedLogins: profile.excludedLogins,
      ownerId: profile.ownerId,
      youtubeAccount: profile.youtubeAccount,
    };
    const periods = {
      all: [SYNTHETIC_START - 86400000, SYNTHETIC_END],
      split: [SYNTHETIC_START + 3 * 86400000 + 3600000, SYNTHETIC_START + 9 * 86400000],
    } as const;
    // Options read by the report itself; presentation options are covered through the store below.
    const variants: Partial<AnalyticsOptions>[] = [
      {},
      { source: 'twitch' },
      { source: 'youtube' },
      { excludedLogins: false },
      { excludedLogins: [] },
      { source: 'twitch', excludedLogins: false },
      { source: 'youtube', excludedLogins: false },
      { activityOnly: true },
      { donationsOnly: true },
      { activityInput: [] },
      { regularThresholdPercent: 30 },
      { regularThresholdPercent: 100 },
      { timezone: 'UTC' },
      { timezone: 'Asia/Tokyo' },
      { youtubeAccount: '' },
      { ownerId: '' },
      { chatWindowMinutes: 1 },
      { chatWindowMinutes: 30 },
      { category: 'game-a' },
      { category: 'talk' },
      { category: 'missing' },
      { corePeople: [] },
      { audienceOffset: -1 },
      { clockResolution: 7 },
      { coreWindowDays: 7 },
    ];
    for (const [period, [fromMs, toMs]] of Object.entries(periods))
      for (const variant of variants) {
        run(`direct ${period} ${stable(variant)}`, () =>
          audienceAnalytics(reads, { fromMs, toMs, ...base, ...variant } as AnalyticsOptions),
        );
      }
    run('direct invalid range', () => audienceAnalytics(reads, { fromMs: 10, toMs: 5 }));
    run('direct missing session', () =>
      audienceAnalytics(reads, { fromMs: 0, toMs: SYNTHETIC_END, sessionId: 'missing' }),
    );
    for (const [period, [fromMs, toMs]] of Object.entries(periods))
      for (const variant of [
        {},
        { excludedLogins: false },
        { panel: 'time' },
        { panel: 'audience' },
        { panel: 'dynamics' },
        { source: 'youtube' },
        { includeInsights: true },
        { rollingCore: true, coreWindowDays: 30 },
        { summaryOnly: true },
        { clockCompact: true, clockDay: 'weekends', clockResolution: 15 },
        { clockResolution: 1, clockMinute: 960 },
        { clockDay: 'пт', clockOffset: 2 },
        { audienceSort: 'messages', audienceOffset: 3 },
        { audienceSearch: 'view' },
        { audienceCoreOnly: true },
        { attendanceOnly: true },
        { membershipOnly: true },
        { category: 'game-a' },
        { timezone: 'UTC' },
      ] as Partial<AnalyticsOptions>[]) {
        run(`store ${period} ${stable(variant)}`, () =>
          settle(() => store.analytics({ fromMs, toMs, ...base, ...variant } as AnalyticsOptions)),
        );
      }
    run('insights all', () => settle(() => store.insights(undefined, profile.excludedLogins, { toMs: SYNTHETIC_END })));
    run('insights all with bots', () => settle(() => store.insights(undefined, false, { toMs: SYNTHETIC_END })));
    const sessions = reads
      .prepare(
        'SELECT id FROM sessions WHERE NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=sessions.id) ORDER BY started_at_ms',
      )
      .all() as { id: string }[];
    const reports: { id: string; report: ReturnType<typeof audienceAnalytics> }[] = [];
    for (const { id } of sessions) {
      const options = { fromMs: 0, toMs: SYNTHETIC_END, sessionId: id, ...base };
      const report = run(`session ${id}`, () => audienceAnalytics(reads, options)) as
        ReturnType<typeof audienceAnalytics> | { error: string };
      if (!('error' in report)) reports.push({ id, report });
      run(`session bots ${id}`, () =>
        audienceAnalytics(reads, { ...options, excludedLogins: false, clockResolution: 5 }),
      );
      run(`session activity ${id}`, () => audienceAnalytics(reads, { ...options, activityOnly: true }));
      run(`session youtube ${id}`, () => audienceAnalytics(reads, { ...options, source: 'youtube' }));
      run(`store session ${id}`, () => settle(() => store.analytics(options)));
      run(`insights session ${id}`, () =>
        settle(() => store.insights(id, profile.excludedLogins, { toMs: SYNTHETIC_END })),
      );
      run(`stream insights ${id}`, () => streamInsights(report as ReturnType<typeof audienceAnalytics>));
      run(`stream insights utc ${id}`, () => streamInsights(report as ReturnType<typeof audienceAnalytics>, 'UTC'));
    }
    const tips = (id: string) =>
      reads
        .prepare(
          "SELECT i.person_id AS personId,e.occurred_at_ms AS at FROM event_sessions es CROSS JOIN effective_events e ON e.id=es.event_id JOIN identities i ON i.id=e.identity_id WHERE es.session_id=? AND e.type='donation' ORDER BY e.occurred_at_ms,e.id",
        )
        .all(id) as { personId: string; at: number }[];
    for (const [timezone, focus, complete] of [
      ['Europe/Moscow', '', true],
      ['UTC', '', false],
      ['Europe/Moscow', reports.at(-1)?.id ?? '', true],
      ['Europe/Moscow', reports[3]?.id ?? '', true],
    ] as const) {
      run(`accumulator ${timezone} ${focus} ${complete}`, () => {
        const insights = new InsightAccumulator(new Map(), timezone, focus);
        for (const { id, report } of reports) insights.add(report, complete, tips(id));
        return { cards: [...insights.find()], state: insights.snapshot() };
      });
      run(`merged accumulator ${timezone} ${focus} ${complete}`, () => {
        const parts = [0, 1, 2].map((part) => {
          const insights = new InsightAccumulator(new Map(), timezone);
          reports
            .filter((_, i) => i % 3 === part)
            .forEach(({ id, report }) => insights.add(report, complete, tips(id)));
          return insights.snapshot();
        });
        const merged = new InsightAccumulator(new Map(), timezone, focus);
        parts.forEach((part) => merged.append(part));
        return [...merged.find()];
      });
    }
    // Ingestion: every stored fact, in insertion order.
    for (const { name } of reads
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'analytics_%' ORDER BY name",
      )
      .all() as { name: string }[]) {
      // Every column orders the rows, so the dump does not depend on rowids or on the query plan.
      const columns = reads
        .prepare(`SELECT * FROM "${name}" LIMIT 0`)
        .columns()
        .map((_, i) => i + 1)
        .join(',');
      run(`table ${name}`, () => reads.prepare(`SELECT * FROM "${name}" ORDER BY ${columns}`).all());
    }
    if (process.env.STREAM_PANEL_WRITE_CHARACTERIZATION) {
      writeFileSync(golden, JSON.stringify(results, null, 1) + '\n');
      return;
    }
    const expected = JSON.parse(readFileSync(golden, 'utf8')) as Record<string, string>;
    assert.deepEqual(Object.keys(results), Object.keys(expected), 'the characterized cases changed');
    for (const label of Object.keys(expected)) assert.equal(results[label], expected[label], label);
  } finally {
    store.close();
    crypto.randomUUID = realUuid;
    syncBuiltinESMExports();
    Date.now = realNow;
  }
});
