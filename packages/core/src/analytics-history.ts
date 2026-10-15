import { HistoryTimeline } from "./history-timeline.js";
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { audienceAnalytics, unionSpans, type AnalyticsOptions } from './analytics.js';
import { timeAudience, matchesActivityDay, type TimeAudienceSummary } from './time-audience.js';
import { timePatterns } from './time-patterns.js';
import { currencyRates } from './rates.js';
import { donationTiming } from './donation-statistics.js';
const days = ['all', 'weekdays', 'weekends', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const resolutions = [1, 5, 15, 60];
type Session = {
    id: string;
    started_at_ms: number;
    ended_at_ms: number | null;
    revision: number;
};
type Report = ReturnType<typeof audienceAnalytics> & {
    clockBuckets?: ClockBucket[];
    aggregate?: boolean;
    preparing?: boolean;
    ready?: number;
    total?: number;
    stage?: string;
};
type Person = Report['audience'][number] & {
    sessionCount: number;
    attendanceCount: number;
    activityMinutes: number;
    detailAvailable?: boolean;
};
type Stream = Report['streamComparison'][number];
type Category = Report['categories'][number] & {
    people: Set<string>;
};
type Hour = Report['hours'][number];
type Progress = {
    preparing: true;
    ready: number;
    total: number;
};
export type ClockBucket = TimeAudienceSummary;
const sumMoney = (target: Record<string, string>, input: Record<string, string>) => { for (const [currency, amount] of Object.entries(input))
    target[currency] = (BigInt(target[currency] ?? '0') + BigInt(amount)).toString(); };
/** Incremental, derived closed-stream reports. Facts and public event IDs are untouched. */
export class AnalyticsHistory {
    private statements = new Map<string, Database.Statement>();
    private statement(sql: string) {
        let statement = this.statements.get(sql);
        if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
        return statement;
    }
    private completed: { key: string; value: Report } | undefined;
    private readonly jobs = new Map<string, {
        iterator: Generator<Progress, Report, void>;
        touchedAt: number;
    }>();
    private pruneJobs(now=Date.now()) {
        for (const [key, job] of this.jobs)
            if (now-job.touchedAt>300000) this.jobs.delete(key);
    }
    constructor(private readonly db: Database.Database, private readonly cachePolicy: {
        availableBytes?: () => number;
        maxBytes?: number;
        maxTotalBytes?: number;
    } = {}) { }
    private budgetChecked = false;
    private checkCacheBudget() {
        if (this.budgetChecked) return;
        this.db.transaction(() => this.trimCache('', '')).immediate();
        this.budgetChecked = true;
    }
    private sessions(options: AnalyticsOptions): Session[] {
        return this.statement(`SELECT s.id,s.started_at_ms,s.ended_at_ms,coalesce(r.revision,0) AS revision FROM sessions s LEFT JOIN analytics_stream_revisions r ON r.session_id=s.id
   WHERE NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=s.id) AND s.started_at_ms<? AND coalesce(s.ended_at_ms,?)>? ORDER BY s.started_at_ms,s.id`).all(options.toMs, options.toMs, options.fromMs) as Session[];
    }
    private key(options: AnalyticsOptions, session: Session): string {
        const fields = { format: 1, from: Math.max(options.fromMs, session.started_at_ms), to: Math.min(options.toMs, session.ended_at_ms ?? options.toMs), source: options.source ?? 'all', category: options.category ?? '', timezone: options.timezone ?? 'Europe/Moscow', chatWindowMinutes: options.chatWindowMinutes ?? 5, excluded: [...(options.excludedLogins ?? [])].sort(), owner: options.ownerId ?? '', youtube: options.youtubeAccount ?? '' };
        return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
    }
    private globalRevision() { return (this.statement('SELECT revision FROM analytics_global_revision WHERE id=1').get() as {
        revision: number;
    }).revision; }
    private build(options: AnalyticsOptions, session: Session): Report {
        const report = audienceAnalytics(this.db, { ...options, sessionId: session.id });
        // Each cached report represents one logical stream; attendance is deduplicated
        // within that report before counts from different streams are added.
        const clockBuckets: ClockBucket[] = [];
        const clock = new Intl.DateTimeFormat('ru-RU', { timeZone: options.timezone ?? 'Europe/Moscow', weekday: 'short' }), presentDays = new Set<string>();
        for (const span of report.activityWindows) {
            presentDays.add(clock.format(span.to - 1));
            for (let at = span.from; at < span.to; at = Math.min(span.to, (Math.floor(at / 3600000) + 1) * 3600000))
                presentDays.add(clock.format(at));
        }
        const common = presentDays.size === 1 ? new Map(resolutions.map(resolution => [resolution, timeAudience(report.activityWindows, report.audience, options.timezone ?? 'Europe/Moscow', resolution, 'all')])) : null;
        for (const day of days) {
            if (![...presentDays].some(d => matchesActivityDay(day, d)))
                continue;
            for (const resolution of resolutions)
                for (const bucket of common?.get(resolution) ?? timeAudience(report.activityWindows, report.audience, options.timezone ?? 'Europe/Moscow', resolution, day)) {
                    if (!bucket.streams.size)
                        continue;
                    clockBuckets.push({ day, resolution, minute: bucket.minute, streams: bucket.streams.size, airtimeMs: bucket.airtimeMs, personTimeMs: bucket.personTimeMs, averageAudience: bucket.averageAudience, people: [...bucket.people].map(([id, streams]) => ({ id, visits: streams.size })) });
                }
        }
        return { ...report, clockBuckets };
    }
    private cached(options: AnalyticsOptions, session: Session, global: number): Report | undefined {
        if (session.ended_at_ms === null)
            return undefined;
        const row = this.statement('SELECT payload FROM analytics_stream_cache WHERE session_id=? AND cache_key=? AND revision=? AND global_revision=?').get(session.id, this.key(options, session), session.revision, global) as {
            payload: Buffer;
        } | undefined;
        if (!row)
            return undefined;
        try {
            return JSON.parse(gunzipSync(row.payload, { maxOutputLength: this.cachePolicy.maxBytes ?? 16 * 1024 * 1024 }).toString()) as Report;
        }
        catch {
            this.statement('DELETE FROM analytics_stream_cache WHERE session_id=? AND cache_key=?').run(session.id, this.key(options, session));
            return undefined;
        }
    }
    /** Derived reports may be evicted; facts and late corrections remain authoritative. */
    private trimCache(protectedSession: string, protectedKey: string): boolean {
        const limit = this.cachePolicy.maxTotalBytes ?? 128 * 1024 * 1024;
        let total = (this.statement('SELECT coalesce(sum(length(payload)),0) AS bytes FROM analytics_stream_cache').get() as {bytes:number}).bytes, evicted = false;
        while (total > limit) {
            // Bound JS allocations even when years of reports are present.
            const rows = this.statement('SELECT session_id,cache_key,length(payload) AS bytes FROM analytics_stream_cache WHERE session_id<>? OR cache_key<>? ORDER BY updated_at_ms,session_id,cache_key LIMIT 64').all(protectedSession, protectedKey) as {session_id:string;cache_key:string;bytes:number}[];
            if (!rows.length) break;
            for (const row of rows) {
                if (total <= limit) break;
                this.statement('DELETE FROM analytics_stream_cache WHERE session_id=? AND cache_key=?').run(row.session_id, row.cache_key);
                total -= row.bytes;
                evicted = true;
            }
        }
        return evicted;
    }
    private save(options: AnalyticsOptions, session: Session, global: number, report: Report, allowEviction = true) {
        if (session.ended_at_ms === null)
            return;
        const serialized = JSON.stringify(report);
        if (Buffer.byteLength(serialized) > (this.cachePolicy.maxBytes ?? 16 * 1024 * 1024))
            return false;
        let available = this.cachePolicy.availableBytes?.() ?? Infinity;
        if (!this.cachePolicy.availableBytes && this.db.name !== ':memory:') {
            const disk = statfsSync(dirname(this.db.name));
            available = disk.bavail * disk.bsize;
        }
        if (available < 1024 * 1024 * 1024)
            return false;
        const payload = gzipSync(serialized);
        if (payload.byteLength > (this.cachePolicy.maxTotalBytes ?? 128 * 1024 * 1024)) return false;
        if (!allowEviction) {
            const retained = (this.statement('SELECT coalesce(sum(length(payload)),0) AS bytes FROM analytics_stream_cache WHERE NOT(session_id=? AND (cache_key=? OR revision<>? OR global_revision<>?))').get(session.id, this.key(options, session), session.revision, global) as {bytes:number}).bytes;
            if (retained + payload.byteLength > (this.cachePolicy.maxTotalBytes ?? 128 * 1024 * 1024)) return false;
        }
        return this.db.transaction(() => {
            this.statement('DELETE FROM analytics_stream_cache WHERE session_id=? AND (revision<>? OR global_revision<>?)').run(session.id, session.revision, global);
            this.statement('INSERT INTO analytics_stream_cache VALUES (?,?,?,?,?,?) ON CONFLICT(session_id,cache_key) DO UPDATE SET revision=excluded.revision,global_revision=excluded.global_revision,payload=excluded.payload,updated_at_ms=excluded.updated_at_ms').run(session.id, this.key(options, session), session.revision, global, payload, Date.now());
            this.statement('DELETE FROM analytics_stream_cache WHERE session_id=? AND cache_key<>? AND cache_key NOT IN(SELECT cache_key FROM analytics_stream_cache WHERE session_id=? AND cache_key<>? ORDER BY updated_at_ms DESC,cache_key DESC LIMIT 15)').run(session.id, this.key(options, session), session.id, this.key(options, session));
            return !this.trimCache(session.id, this.key(options, session));
        }).immediate();
    }
    prepare(options: AnalyticsOptions, sessions = this.sessions(options)) {
        this.pruneJobs();
        this.checkCacheBudget();
        const global = this.globalRevision(), start = performance.now();
        let ready = 0, built = 0;
        for (const session of [...sessions].reverse()) {
            if (session.ended_at_ms === null) {
                ready++;
                continue;
            }
            if (this.statement('SELECT 1 FROM analytics_stream_cache WHERE session_id=? AND cache_key=? AND revision=? AND global_revision=?').get(session.id, this.key(options, session), session.revision, global)) {
                ready++;
                continue;
            }
            if (built >= 5 || performance.now() - start > 250)
                continue;
            // Warming is optional: a budget smaller than history must not loop forever.
            if (!this.save(options, session, global, this.build(options, session), false))
                return { preparing: false, ready, total: sessions.length };
            ready++;
            built++;
        }
        return { preparing: ready < sessions.length, ready, total: sessions.length };
    }
    report(options: AnalyticsOptions): Report {
        this.checkCacheBudget();
        // Reuse the established validation, including timezone/core/source checks,
        // without expanding the historical period before it is known to be valid.
        if (!Number.isSafeInteger(options.fromMs) || options.fromMs < 0 || !Number.isSafeInteger(options.toMs) || options.toMs <= options.fromMs)
            throw new Error('INVALID_ANALYTICS_FILTER');
        const validation = audienceAnalytics(this.db, { ...options, fromMs: options.toMs - 1, toMs: options.toMs });
        const sessions = this.sessions(options);
        const live = sessions.some(session => session.ended_at_ms === null);
        const lastEnd = sessions.reduce((end, session) => Math.max(end, session.ended_at_ms ?? options.toMs), options.fromMs);
        const canonical = { ...options, fromMs: Math.max(options.fromMs, sessions[0]?.started_at_ms ?? options.fromMs), toMs: live ? options.toMs : Math.min(options.toMs, lastEnd) };
        const fingerprint = createHash('sha256').update(JSON.stringify([canonical, this.globalRevision(), sessions.map(s => [s.id, s.ended_at_ms === null ? 0 : s.revision]), this.statement('SELECT * FROM person_preferences ORDER BY person_id').all(), this.statement('SELECT * FROM person_tags ORDER BY person_id,label').all(), this.statement('SELECT source,account_id,max(observed_at_ms) AS at FROM follower_observations GROUP BY source,account_id').all()])).digest('hex');
        if (!live && this.completed?.key === fingerprint) {
            const youtube = options.source !== 'twitch' && options.youtubeAccount ? this.statement("SELECT payload_json,updated_at_ms FROM youtube_snapshots WHERE account_id=? AND key='report'").get(options.youtubeAccount) as { payload_json: string; updated_at_ms: number } | undefined : undefined;
            return { ...this.completed.value, filters: { ...validation.filters, fromMs: options.fromMs, toMs: options.toMs }, youtubeReport: youtube ? { data: JSON.parse(youtube.payload_json), updatedAt: youtube.updated_at_ms } : null, donationTiming: donationTiming(this.db, options.fromMs, options.toMs, options.timezone ?? 'Europe/Moscow') };
        }
        const now = Date.now();
        this.pruneJobs(now);
        let job = this.jobs.get(fingerprint);
        if (!job) {
            // Each browser/filter keeps its own progress, with a bounded LRU budget.
            while (this.jobs.size >= 4) this.jobs.delete(this.jobs.keys().next().value!);
            job = { iterator: this.aggregate(options, sessions, validation), touchedAt: now };
        }
        this.jobs.delete(fingerprint);
        this.jobs.set(fingerprint, job);
        job.touchedAt = now;
        let next: IteratorResult<Progress, Report>;
        try {
            next = job.iterator.next();
        }
        catch (error) {
            this.jobs.delete(fingerprint);
            throw error;
        }
        if (!next.done)
            return { ...validation, ...next.value, stage: 'aggregate' };
        this.jobs.delete(fingerprint);
        if (!live) this.completed = { key: fingerprint, value: next.value };
        return next.value;
    }
    private *aggregate(options: AnalyticsOptions, sessions: Session[], validation: ReturnType<typeof audienceAnalytics>): Generator<Progress, Report, void> {
        let built = 0, sliceStart = performance.now();
        const active = new Map<string, Report>(), read = (session: Session) => {
            if (session.ended_at_ms === null) {
                let report = active.get(session.id);
                if (!report) {
                    report = this.build(options, session);
                    built++;
                    active.set(session.id, report);
                }
                return report;
            }
            let report = this.cached(options, session, this.globalRevision());
            if (!report) {
                report = this.build(options, session);
                built++;
                this.save(options, session, this.globalRevision(), report);
            }
            return report;
        };
        let processed = 0;
        const people = new Map<string, Person>(), streams: Stream[] = [], categoryRows = new Map<string, Category>(), hours = new Map<string, Hour>(), clockRows = new Map<string, ClockBucket>(), clockPeople = new Map<string, Map<string, {
            id: string;
            visits: number;
        }>>(), categories = new Map<string, {
            id: string;
            name: string;
        }>();
        let sample: Report | undefined;
        let selectedStreams = 0;
        for (const session of sessions) {
            const report = read(session);
            sample = report;
            if (report.summary.streams)
                selectedStreams++;
            for (const category of report.availableCategories)
                categories.set(category.id, category);
            const stream = report.streamComparison[0];
            if (stream)
                streams.push({ ...stream });
            for (const person of report.audience) {
                let row = people.get(person.id);
                if (!row) {
                    row = { ...person, sessionCount: 0, attendanceCount: 0, sessionIds: [], attendanceSessionIds: [], intervals: [], messageMinutes: [], messageCounts: [], messages: 0, observedMinutes: 0, estimatedChatMinutes: 0, donations: {}, visits: 0, activityMinutes: 0, arrivalHours: [] };
                    people.set(person.id, row);
                }
                row.messages += person.messages;
                row.visits += person.visits;
                for (const span of person.intervals) {
                    const minutes = (span.to - span.from) / 60000;
                    if (span.kind === 'observed')
                        row.observedMinutes += minutes;
                    else
                        row.estimatedChatMinutes += minutes;
                }
                row.activityMinutes += unionSpans(person.intervals.map(span => ({ ...span, kind: 'observed' as const }))).reduce((n, span) => n + (span.to - span.from) / 60000, 0);
                row.sources = [...new Set([...row.sources, ...person.sources])];
                row.accounts = [...new Map([...row.accounts, ...person.accounts].map((a) => [a.source + ':' + a.name, a])).values()];
                row.sessionCount += person.sessionIds.length;
                row.attendanceCount += person.attendanceSessionIds.length;
                row.sessionIds = [...row.sessionIds, ...person.sessionIds].slice(-100);
                row.attendanceSessionIds = [...row.attendanceSessionIds, ...person.attendanceSessionIds].slice(-100);
                sumMoney(row.donations, person.donations);
                row.intervals = [...row.intervals, ...person.intervals].slice(-100);
                row.messageMinutes = [...row.messageMinutes, ...person.messageMinutes].slice(-100);
                for (const arrival of person.arrivalHours) {
                    let prior = row.arrivalHours.find((a) => a.day === arrival.day && a.hour === arrival.hour);
                    if (!prior) {
                        prior = { ...arrival, visits: 0 };
                        row.arrivalHours.push(prior);
                    }
                    prior.visits += arrival.visits;
                }
            }
            for (const category of report.categories) {
                let row = categoryRows.get(category.id);
                if (!row) {
                    row = { ...category, minutes: 0, messages: 0, observedMinutes: 0, observedKnownMinutes: 0, estimatedChatMinutes: 0, sessions: 0, donationCount: 0, donationTotals: {}, people: new Set<string>() };
                    categoryRows.set(category.id, row);
                }
                for (const key of ['minutes', 'messages', 'observedMinutes', 'observedKnownMinutes', 'estimatedChatMinutes', 'sessions', 'donationCount'] as const)
                    row[key] += category[key];
                sumMoney(row.donationTotals, category.donationTotals);
                for (const person of report.audience)
                    if (person.intervals.some(span => report.activityWindows.some(w => w.categoryId === category.id && w.session === span.session && w.from < span.to && w.to > span.from)) || person.messageMinutes.some(m => report.activityWindows.some(w => w.categoryId === category.id && w.session === m.session && m.at >= w.from && m.at < w.to)))
                        row.people.add(person.id);
            }
            for (const cell of report.hours) {
                const key = cell.day + ':' + cell.hour;
                let row = hours.get(key);
                if (!row) {
                    row = { ...cell, observed: 0, estimated: 0, messages: 0, sampleMinutes: 0, observedKnownMinutes: 0, viewersTotal: 0, viewerSamples: 0, donationCount: 0, donationTotals: {} };
                    hours.set(key, row);
                }
                for (const field of ['observed', 'estimated', 'messages', 'sampleMinutes', 'observedKnownMinutes', 'viewersTotal', 'viewerSamples', 'donationCount'] as const)
                    row[field] += cell[field];
                sumMoney(row.donationTotals, cell.donationTotals);
            }
            for (const bucket of report.clockBuckets ?? []) {
                const key = `${bucket.day}:${bucket.resolution}:${bucket.minute}`;
                let row = clockRows.get(key);
                if (!row) {
                    row = { ...bucket, streams: 0, airtimeMs: 0, personTimeMs: 0, people: [] };
                    clockRows.set(key, row);
                    clockPeople.set(key, new Map());
                }
                row.streams += bucket.streams;
                row.airtimeMs += bucket.airtimeMs;
                row.personTimeMs += bucket.personTimeMs;
                for (const person of bucket.people) {
                    const visits = clockPeople.get(key)!, prior = visits.get(person.id);
                    if (prior)
                        prior.visits += person.visits;
                    else
                        visits.set(person.id, { ...person });
                }
            }
            if (++processed % 25 === 0 || built >= 5 || performance.now() - sliceStart > 250) {
                yield { preparing: true, ready: processed, total: sessions.length * 2 };
                built = 0;
                sliceStart = performance.now();
            }
        }
        if (!sample)
            return audienceAnalytics(this.db, options);
        const preferences = new Map((this.statement('SELECT person_id,manual_core FROM person_preferences').all() as {
            person_id: string;
            manual_core: number | null;
        }[]).map(p => [p.person_id, p.manual_core]));
        for (const person of people.values()) {
            person.source = person.sources.includes('twitch') ? 'twitch' : 'youtube';
            const attendance = person.attendanceCount, ratio = selectedStreams ? attendance / selectedStreams : 0, long = person.activityMinutes >= (options.minMinutes ?? 30), chatty = person.messages >= (options.minMessages ?? 5), rule = options.coreRule ?? 'either';
            const automatic = attendance > 0 && attendance >= (options.minSessions ?? 3) && ratio * 100 + 1e-10 >= (options.regularThresholdPercent ?? 80) && (rule === 'frequency' || (rule === 'both' ? long && chatty : long || chatty));
            const override = preferences.get(person.id);
            person.manualCore = override == null ? null : override === 1;
            person.core = person.manualCore ?? automatic;
            person.regular = person.core;
            person.attendanceRatio = ratio;
            person.sessionRatio = selectedStreams ? person.sessionCount / selectedStreams : 0;
            person.observedMinutesPerSession = attendance ? person.observedMinutes / attendance : 0;
            person.detailAvailable = true;
        }
        const current = this.statement("SELECT p.source,p.account_id,p.payload_json FROM follower_observations p WHERE p.id=(SELECT q.id FROM follower_observations q WHERE q.source=p.source AND q.account_id=p.account_id ORDER BY q.observed_at_ms DESC,q.id DESC LIMIT 1)").all() as {
            source: string;
            account_id: string;
            payload_json: string;
        }[];
        const followers = new Set<string>(), negative = new Set<string>();
        for (const snapshot of current) {
            const info = JSON.parse(snapshot.payload_json), ids = JSON.stringify(info.followers.map((f: {
                id: string;
            }) => f.id));
            const members = snapshot.source === 'youtube' ? this.statement('SELECT person_id FROM youtube_identities WHERE account_id=? AND external_id IN(SELECT value FROM json_each(?))').all(snapshot.account_id, ids) : this.statement("SELECT person_id FROM identities WHERE source='twitch' AND account_id=? AND external_id IN(SELECT value FROM json_each(?))").all(snapshot.account_id, ids);
            for (const row of members as {
                person_id: string;
            }[])
                followers.add(row.person_id);
            if (snapshot.source === 'twitch' && info.complete)
                for (const row of this.statement("SELECT person_id FROM identities WHERE source='twitch' AND account_id=? AND external_id NOT IN(SELECT value FROM json_each(?))").all(snapshot.account_id, ids) as {
                    person_id: string;
                }[])
                    negative.add(row.person_id);
        }
        for (const person of people.values()) {
            person.follower = followers.has(person.id) ? true : negative.has(person.id) && !person.sources.includes('youtube') ? false : null;
            person.tags = (this.statement(`WITH RECURSIVE owners(id) AS(SELECT ? UNION SELECT m.source_person_id FROM person_merges m JOIN owners o ON m.target_person_id=o.id WHERE m.undone_at_ms IS NULL) SELECT DISTINCT t.label FROM person_tags t JOIN owners o ON o.id=t.person_id ORDER BY t.label`).all(person.id) as {
                label: string;
            }[]).map(t => t.label);
        }
        const daily = new HistoryTimeline(options.timezone ?? 'Europe/Moscow', people);
        const seen = new Set<string>(), streamsById = new Map(streams.map(stream => [stream.id, stream]));
        for (const session of sessions) {
            const report = read(session), stream = streamsById.get(session.id);
            daily.add(report);
            if (stream) {
                const visitors = report.audience.filter(person => person.attendanceSessionIds.length).map(person => person.id);
                stream.core = visitors.filter(id => people.get(id)?.core).length;
                stream.newInPeriod = visitors.filter(id => !seen.has(id)).length;
                stream.returning = visitors.length - stream.newInPeriod;
                for (const id of visitors) seen.add(id);
            }
            if (++processed % 25 === 0 || built >= 5 || performance.now() - sliceStart > 250) {
                yield { preparing: true, ready: processed, total: sessions.length * 2 };
                built = 0;
                sliceStart = performance.now();
            }
        }
        const audience = [...people.values()].sort((a, b) => Number(b.core) - Number(a.core) || b.observedMinutes - a.observedMinutes || b.messages - a.messages);
        const outputCategories = [...categoryRows.values()].map(row => { const { people: ids, ...category } = row; return { ...category, audience: ids.size, core: [...ids].filter(id => people.get(id)?.core).length, donationsPerHourMinor: currencyRates(row.donationTotals, Math.round(row.minutes * 60000)), messagesPerHour: row.minutes ? row.messages * 60 / row.minutes : 0, observedPerMinute: row.minutes ? row.observedMinutes / row.minutes : 0, observedPerKnownMinute: row.observedKnownMinutes ? row.observedMinutes / row.observedKnownMinutes : null, coverageRatio: row.minutes ? row.observedKnownMinutes / row.minutes : null }; });
        for (const [key, row] of clockRows) {
            row.people = [...clockPeople.get(key)!.values()];
            row.averageAudience = row.airtimeMs ? row.personTimeMs / row.airtimeMs : null;
        }
        const attendees = audience.filter(p => p.attendanceSessionIds.length), core = audience.filter(p => p.core).length;
        const youtube = options.source !== 'twitch' && options.youtubeAccount ? this.statement("SELECT payload_json,updated_at_ms FROM youtube_snapshots WHERE account_id=? AND key='report'").get(options.youtubeAccount) as {
            payload_json: string;
            updated_at_ms: number;
        } | undefined : undefined;
        return { ...sample, youtubeReport: youtube ? { data: JSON.parse(youtube.payload_json), updatedAt: youtube.updated_at_ms } : null, aggregate: true, filters: { ...validation.filters, fromMs: options.fromMs, toMs: options.toMs }, activityWindows: [], timeline: daily.values(), breaks: [], sessions: [sessions[0]!], audience, categories: outputCategories, availableCategories: [...categories.values()], streamComparison: streams, clockBuckets: [...clockRows.values()], hours: [...hours.values()], patterns: timePatterns([...hours.values()]), summary: { entities: audience.length, attendees: attendees.length, regulars: core, regularShare: audience.length ? core / audience.length : null, core, streams: selectedStreams, chatters: audience.filter(p => p.messages > 0).length, messages: audience.reduce((n, p) => n + p.messages, 0) }, composition: { core: attendees.filter(p => p.core).length, followers: attendees.filter(p => !p.core && p.follower === true).length, nonFollowers: attendees.filter(p => !p.core && p.follower === false).length, unknown: attendees.filter(p => !p.core && p.follower === null).length, twitch: attendees.filter(p => p.sources.includes('twitch')).length, youtube: attendees.filter(p => p.sources.includes('youtube')).length, both: attendees.filter(p => p.sources.length > 1).length }, donationTiming: donationTiming(this.db, options.fromMs, options.toMs, options.timezone ?? 'Europe/Moscow') };
    }
}
