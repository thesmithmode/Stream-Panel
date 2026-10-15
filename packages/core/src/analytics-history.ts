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
    private job: {
        key: string;
        iterator: Generator<Progress, Report, void>;
    } | undefined;
    constructor(private readonly db: Database.Database, private readonly cachePolicy: {
        availableBytes?: () => number;
        maxBytes?: number;
    } = {}) { }
    private sessions(options: AnalyticsOptions): Session[] {
        return this.db.prepare(`SELECT s.id,s.started_at_ms,s.ended_at_ms,coalesce(r.revision,0) AS revision FROM sessions s LEFT JOIN analytics_stream_revisions r ON r.session_id=s.id
   WHERE NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=s.id) AND s.started_at_ms<? AND coalesce(s.ended_at_ms,?)>? ORDER BY s.started_at_ms,s.id`).all(options.toMs, options.toMs, options.fromMs) as Session[];
    }
    private key(options: AnalyticsOptions, session: Session): string {
        const fields = { format: 1, from: Math.max(options.fromMs, session.started_at_ms), to: Math.min(options.toMs, session.ended_at_ms ?? options.toMs), source: options.source ?? 'all', category: options.category ?? '', timezone: options.timezone ?? 'Europe/Moscow', chatWindowMinutes: options.chatWindowMinutes ?? 5, excluded: [...(options.excludedLogins ?? [])].sort(), owner: options.ownerId ?? '', youtube: options.youtubeAccount ?? '' };
        return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
    }
    private globalRevision() { return (this.db.prepare('SELECT revision FROM analytics_global_revision WHERE id=1').get() as {
        revision: number;
    }).revision; }
    private build(options: AnalyticsOptions, session: Session): Report {
        const report = audienceAnalytics(this.db, { ...options, sessionId: session.id });
        // Each cached report represents one logical stream; attendance is deduplicated
        // within that report before counts from different streams are added.
        const clockBuckets: ClockBucket[] = [];
        const clock = new Intl.DateTimeFormat('ru-RU', { timeZone: options.timezone ?? 'Europe/Moscow', weekday: 'short' }), presentDays = new Set<string>();
        for (const span of report.activityWindows)
            for (let at = span.from; at < span.to; at = Math.min(span.to, (Math.floor(at / 3600000) + 1) * 3600000))
                presentDays.add(clock.format(at));
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
        const row = this.db.prepare('SELECT payload FROM analytics_stream_cache WHERE session_id=? AND cache_key=? AND revision=? AND global_revision=?').get(session.id, this.key(options, session), session.revision, global) as {
            payload: Buffer;
        } | undefined;
        if (!row)
            return undefined;
        try {
            return JSON.parse(gunzipSync(row.payload, { maxOutputLength: this.cachePolicy.maxBytes ?? 16 * 1024 * 1024 }).toString()) as Report;
        }
        catch {
            this.db.prepare('DELETE FROM analytics_stream_cache WHERE session_id=? AND cache_key=?').run(session.id, this.key(options, session));
            return undefined;
        }
    }
    private save(options: AnalyticsOptions, session: Session, global: number, report: Report) {
        if (session.ended_at_ms === null)
            return;
        const serialized = JSON.stringify(report);
        if (Buffer.byteLength(serialized) > (this.cachePolicy.maxBytes ?? 16 * 1024 * 1024))
            throw new Error('ANALYTICS_STREAM_TOO_LARGE');
        let available = this.cachePolicy.availableBytes?.() ?? Infinity;
        if (!this.cachePolicy.availableBytes && this.db.name !== ':memory:') {
            const disk = statfsSync(dirname(this.db.name));
            available = disk.bavail * disk.bsize;
        }
        if (available < 1024 * 1024 * 1024)
            throw new Error('ANALYTICS_STORAGE_LOW');
        this.db.transaction(() => {
            this.db.prepare('DELETE FROM analytics_stream_cache WHERE session_id=? AND (revision<>? OR global_revision<>?)').run(session.id, session.revision, global);
            this.db.prepare('INSERT INTO analytics_stream_cache VALUES (?,?,?,?,?,?) ON CONFLICT(session_id,cache_key) DO UPDATE SET revision=excluded.revision,global_revision=excluded.global_revision,payload=excluded.payload,updated_at_ms=excluded.updated_at_ms').run(session.id, this.key(options, session), session.revision, global, gzipSync(serialized), Date.now());
            this.db.prepare('DELETE FROM analytics_stream_cache WHERE session_id=? AND cache_key NOT IN(SELECT cache_key FROM analytics_stream_cache WHERE session_id=? ORDER BY updated_at_ms DESC LIMIT 16)').run(session.id, session.id);
        }).immediate();
    }
    prepare(options: AnalyticsOptions, sessions = this.sessions(options)) {
        const global = this.globalRevision(), start = performance.now();
        let ready = 0, built = 0;
        for (const session of sessions) {
            if (session.ended_at_ms === null) {
                ready++;
                continue;
            }
            if (this.db.prepare('SELECT 1 FROM analytics_stream_cache WHERE session_id=? AND cache_key=? AND revision=? AND global_revision=?').get(session.id, this.key(options, session), session.revision, global)) {
                ready++;
                continue;
            }
            if (built >= 5 || performance.now() - start > 250)
                continue;
            this.save(options, session, global, this.build(options, session));
            ready++;
            built++;
        }
        return { preparing: ready < sessions.length, ready, total: sessions.length };
    }
    report(options: AnalyticsOptions): Report {
        // Reuse the established validation, including timezone/core/source checks,
        // without expanding the historical period before it is known to be valid.
        if (!Number.isSafeInteger(options.fromMs) || options.fromMs < 0 || !Number.isSafeInteger(options.toMs) || options.toMs <= options.fromMs)
            throw new Error('INVALID_ANALYTICS_FILTER');
        const validation = audienceAnalytics(this.db, { ...options, fromMs: options.toMs - 1, toMs: options.toMs });
        const sessions = this.sessions(options), progress = this.prepare(options, sessions);
        if (progress.preparing)
            return { ...validation, ...progress };
        const fingerprint = createHash('sha256').update(JSON.stringify([options, this.globalRevision(), sessions.map(s => [s.id, s.ended_at_ms === null ? 0 : s.revision]), this.db.prepare('SELECT * FROM person_preferences ORDER BY person_id').all(), this.db.prepare('SELECT source,account_id,max(observed_at_ms) AS at FROM follower_observations GROUP BY source,account_id').all()])).digest('hex');
        if (this.job?.key !== fingerprint)
            this.job = { key: fingerprint, iterator: this.aggregate(options, sessions, validation) };
        let next: IteratorResult<Progress, Report>;
        try {
            next = this.job.iterator.next();
        }
        catch (error) {
            this.job = undefined;
            throw error;
        }
        if (!next.done)
            return { ...validation, ...next.value, stage: 'aggregate' };
        this.job = undefined;
        return next.value;
    }
    private *aggregate(options: AnalyticsOptions, sessions: Session[], validation: ReturnType<typeof audienceAnalytics>): Generator<Progress, Report, void> {
        const active = new Map<string, Report>(), read = (session: Session) => {
            if (session.ended_at_ms === null) {
                let report = active.get(session.id);
                if (!report) {
                    report = this.build(options, session);
                    active.set(session.id, report);
                }
                return report;
            }
            let report = this.cached(options, session, this.globalRevision());
            if (!report) {
                report = this.build(options, session);
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
            if (++processed % 25 === 0)
                yield { preparing: true, ready: processed, total: sessions.length * 2 };
        }
        if (!sample)
            return audienceAnalytics(this.db, options);
        const preferences = new Map((this.db.prepare('SELECT person_id,manual_core FROM person_preferences').all() as {
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
        const current = this.db.prepare("SELECT p.source,p.account_id,p.payload_json FROM follower_observations p WHERE p.id=(SELECT q.id FROM follower_observations q WHERE q.source=p.source AND q.account_id=p.account_id ORDER BY q.observed_at_ms DESC,q.id DESC LIMIT 1)").all() as {
            source: string;
            account_id: string;
            payload_json: string;
        }[];
        const followers = new Set<string>(), negative = new Set<string>();
        for (const snapshot of current) {
            const info = JSON.parse(snapshot.payload_json), ids = JSON.stringify(info.followers.map((f: {
                id: string;
            }) => f.id));
            const members = snapshot.source === 'youtube' ? this.db.prepare('SELECT person_id FROM youtube_identities WHERE account_id=? AND external_id IN(SELECT value FROM json_each(?))').all(snapshot.account_id, ids) : this.db.prepare("SELECT person_id FROM identities WHERE source='twitch' AND account_id=? AND external_id IN(SELECT value FROM json_each(?))").all(snapshot.account_id, ids);
            for (const row of members as {
                person_id: string;
            }[])
                followers.add(row.person_id);
            if (snapshot.source === 'twitch' && info.complete)
                for (const row of this.db.prepare("SELECT person_id FROM identities WHERE source='twitch' AND account_id=? AND external_id NOT IN(SELECT value FROM json_each(?))").all(snapshot.account_id, ids) as {
                    person_id: string;
                }[])
                    negative.add(row.person_id);
        }
        for (const person of people.values()) {
            person.follower = followers.has(person.id) ? true : negative.has(person.id) && !person.sources.includes('youtube') ? false : null;
            person.tags = (this.db.prepare(`WITH RECURSIVE owners(id) AS(SELECT ? UNION SELECT m.source_person_id FROM person_merges m JOIN owners o ON m.target_person_id=o.id WHERE m.undone_at_ms IS NULL) SELECT DISTINCT t.label FROM person_tags t JOIN owners o ON o.id=t.person_id ORDER BY t.label`).all(person.id) as {
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
            if (++processed % 25 === 0)
                yield { preparing: true, ready: processed, total: sessions.length * 2 };
        }
        const audience = [...people.values()].sort((a, b) => Number(b.core) - Number(a.core) || b.observedMinutes - a.observedMinutes || b.messages - a.messages);
        const outputCategories = [...categoryRows.values()].map(row => { const { people: ids, ...category } = row; return { ...category, audience: ids.size, core: [...ids].filter(id => people.get(id)?.core).length, donationsPerHourMinor: currencyRates(row.donationTotals, Math.round(row.minutes * 60000)), messagesPerHour: row.minutes ? row.messages * 60 / row.minutes : 0, observedPerMinute: row.minutes ? row.observedMinutes / row.minutes : 0, observedPerKnownMinute: row.observedKnownMinutes ? row.observedMinutes / row.observedKnownMinutes : null, coverageRatio: row.minutes ? row.observedKnownMinutes / row.minutes : null }; });
        for (const [key, row] of clockRows) {
            row.people = [...clockPeople.get(key)!.values()];
            row.averageAudience = row.airtimeMs ? row.personTimeMs / row.airtimeMs : null;
        }
        const attendees = audience.filter(p => p.attendanceSessionIds.length), core = audience.filter(p => p.core).length;
        const youtube = options.source !== 'twitch' && options.youtubeAccount ? this.db.prepare("SELECT payload_json,updated_at_ms FROM youtube_snapshots WHERE account_id=? AND key='report'").get(options.youtubeAccount) as {
            payload_json: string;
            updated_at_ms: number;
        } | undefined : undefined;
        return { ...sample, youtubeReport: youtube ? { data: JSON.parse(youtube.payload_json), updatedAt: youtube.updated_at_ms } : null, aggregate: true, filters: { ...validation.filters, fromMs: options.fromMs, toMs: options.toMs }, activityWindows: [], timeline: daily.values(), breaks: [], sessions: [sessions[0]!], audience, categories: outputCategories, availableCategories: [...categories.values()], streamComparison: streams, clockBuckets: [...clockRows.values()], hours: [...hours.values()], patterns: timePatterns([...hours.values()]), summary: { entities: audience.length, attendees: attendees.length, regulars: core, regularShare: audience.length ? core / audience.length : null, core, streams: selectedStreams, chatters: audience.filter(p => p.messages > 0).length, messages: audience.reduce((n, p) => n + p.messages, 0) }, composition: { core: attendees.filter(p => p.core).length, followers: attendees.filter(p => !p.core && p.follower === true).length, nonFollowers: attendees.filter(p => !p.core && p.follower === false).length, unknown: attendees.filter(p => !p.core && p.follower === null).length, twitch: attendees.filter(p => p.sources.includes('twitch')).length, youtube: attendees.filter(p => p.sources.includes('youtube')).length, both: attendees.filter(p => p.sources.length > 1).length }, donationTiming: donationTiming(this.db, options.fromMs, options.toMs, options.timezone ?? 'Europe/Moscow') };
    }
}
