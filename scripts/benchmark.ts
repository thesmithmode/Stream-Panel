import Database from "better-sqlite3";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { StreamStore } from "../packages/core/src/store.js";

const directory = await mkdtemp(join(tmpdir(), "stream-panel-benchmark-"));
const path = join(directory, "benchmark.sqlite");
const store = new StreamStore(path);
const delay = monitorEventLoopDelay({ resolution: 10 });
const timings: number[] = [];
const quantile = (values: number[], q: number) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * q))
  ]!;
let probe: Database.Database | undefined;
delay.enable();
try {
  const started = performance.now();
  for (let i = 0; i < 10_000; i++) {
    const before = performance.now();
    store.ingest({
      source: "twitch",
      accountId: "synthetic-channel",
      externalId: `m${i}`,
      type: "chat.message",
      actor: { externalId: `u${i % 1000}`, displayName: `User${i % 1000}` },
      occurredAtMs: 1_790_000_000_000 + i * 100,
      receivedAtMs: 1_790_000_000_001 + i * 100,
      sourceTime: null,
      timeQuality: "provider",
      transport: "eventsub",
      payload: { text: "synthetic message" },
    });
    timings.push(performance.now() - before);
    if (i % 100 === 99) await setImmediate();
  }
  const ingestionElapsedMs = performance.now() - started;
  probe = new Database(path);
  probe.pragma("foreign_keys = ON");
  probe.pragma("synchronous = FULL");
  // Proposed full-snapshot storage layout. This is a sizing experiment, not migration 1.
  probe.exec(`CREATE TABLE benchmark_polls(id INTEGER PRIMARY KEY, sampled_at_ms INTEGER NOT NULL) STRICT;
    CREATE TABLE benchmark_members(poll_id INTEGER NOT NULL REFERENCES benchmark_polls(id), identity_id TEXT NOT NULL REFERENCES identities(id), PRIMARY KEY(poll_id, identity_id)) WITHOUT ROWID;
    CREATE INDEX benchmark_presence_identity ON benchmark_members(identity_id, poll_id);`);
  const identities = probe.prepare("SELECT id FROM identities").all() as {
    id: string;
  }[];
  const pollInsert = probe.prepare("INSERT INTO benchmark_polls VALUES (?, ?)");
  const memberInsert = probe.prepare(
    "INSERT INTO benchmark_members VALUES (?, ?)",
  );
  const batches: number[] = [];
  const insertPoll = probe.transaction((poll: number) => {
    pollInsert.run(poll, 1_790_000_000_000 + poll * 60_000);
    for (const identity of identities) memberInsert.run(poll, identity.id);
  });
  for (let minute = 0; minute < 480; minute++) {
    const before = performance.now();
    insertPoll(minute);
    batches.push(performance.now() - before);
    await setImmediate();
  }
  const queryStarted = performance.now();
  const observed = probe
    .prepare(
      "SELECT count(*) AS n FROM benchmark_members WHERE identity_id = ?",
    )
    .get(identities[0]!.id) as { n: number };
  const presenceQueryMs = performance.now() - queryStarted;
  const integrity = probe.pragma("integrity_check", { simple: true });
  probe.pragma("wal_checkpoint(TRUNCATE)");
  delay.disable();
  console.log(
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        sqlite: probe.prepare("SELECT sqlite_version() AS version").get(),
        caveat:
          "Synthetic local scratch filesystem; not a stream-machine, Windows, network or 8-hour soak benchmark.",
        eventRows: store.eventCount(),
        ingestionElapsedMs,
        eventInsertP50Ms: quantile(timings, 0.5),
        eventInsertP95Ms: quantile(timings, 0.95),
        eventInsertP99Ms: quantile(timings, 0.99),
        presenceRows: identities.length * 480,
        presencePolls: 480,
        presenceBatchP95Ms: quantile(batches, 0.95),
        observedPollsForOneIdentity: observed.n,
        presenceQueryMs,
        databaseBytes: (await stat(path)).size,
        rssBytes: process.memoryUsage().rss,
        eventLoopP99Ms: delay.percentile(99) / 1e6,
        integrity,
      },
      null,
      2,
    ),
  );
} finally {
  delay.disable();
  probe?.close();
  store.close();
  await rm(directory, { recursive: true, force: true });
}
