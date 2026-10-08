import type Database from 'better-sqlite3';
import { botExclusionSet, isExcludedBot } from './bots.js';
export interface AnalyticsOptions {
    fromMs: number;
    toMs: number;
    source?: 'all' | 'twitch' | 'youtube';
    category?: string;
    minSessions?: number;
    minMinutes?: number;
    minMessages?: number;
    coreRule?: 'either' | 'both' | 'frequency';
    chatWindowMinutes?: number;
    timezone?: string;
    excludedLogins?: string[];
    ownerId?: string;
    youtubeAccount?: string;
}
type Span = {
    from: number;
    to: number;
    session: string;
    kind: 'observed' | 'chat_proxy';
};
type Entity = {
    id: string;
    name: string;
    source: 'twitch' | 'youtube';
    messages: number;
    observedMinutes: number;
    estimatedChatMinutes: number;
    sessionIds: Set<string>;
    intervals: Span[];
    donations: Record<string, string>;
    core: boolean;
};
export function unionSpans(spans: Span[]): Span[] {
    const sorted = spans.filter(x => x.to > x.from).sort((a, b) => a.session.localeCompare(b.session) || a.from - b.from || a.to - b.to), out: Span[] = [];
    for (const span of sorted) {
        const last = out.at(-1);
        if (last && last.session === span.session && last.kind === span.kind && span.from <= last.to)
            last.to = Math.max(last.to, span.to);
        else
            out.push({ ...span });
    }
    return out;
}
export function audienceAnalytics(db: Database.Database, options: AnalyticsOptions) {
    const { fromMs: from, toMs: to } = options, source = options.source ?? 'all', category = options.category ?? '', timezone = options.timezone ?? 'Europe/Moscow';
    const minSessions = options.minSessions ?? 3, minMinutes = options.minMinutes ?? 30, minMessages = options.minMessages ?? 5, window = options.chatWindowMinutes ?? 5, rule = options.coreRule ?? 'either';
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to - from > 90 * 86400000 || !['all', 'twitch', 'youtube'].includes(source) || !['either', 'both', 'frequency'].includes(rule) || category.length > 256 || [minSessions, minMinutes, minMessages, window].some(n => !Number.isInteger(n) || n < 0) || minSessions > 1000 || minMinutes > 129600 || minMessages > 1000000 || window < 1 || window > 30)
        throw new Error('INVALID_ANALYTICS_FILTER');
    let clock: Intl.DateTimeFormat;
    try {
        clock = new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
    }
    catch {
        throw new Error('INVALID_TIMEZONE');
    }
    const excluded = botExclusionSet(['fullrandomname_twitch', ...(options.excludedLogins ?? [])]), botJson = JSON.stringify([...excluded]);
    const sessions = db.prepare('SELECT * FROM sessions WHERE started_at_ms<? AND coalesce(ended_at_ms,?)>? ORDER BY started_at_ms LIMIT 1001').all(to, to, from) as any[];
    if (sessions.length > 1000)
        throw new Error('ANALYTICS_RANGE_TOO_LARGE');
    const sessionIds = JSON.stringify(sessions.map(s => s.id));
    const visible = `SELECT p.id,p.display_name FROM persons p WHERE NOT EXISTS(SELECT 1 FROM identities ib WHERE ib.person_id=p.id AND (ib.match_key IN(SELECT value FROM json_each(?)) OR EXISTS(SELECT 1 FROM identity_aliases a WHERE a.identity_id=ib.id AND ltrim(a.candidate_key,'@#') IN(SELECT value FROM json_each(?))) OR (ib.source='twitch' AND (ib.external_id=? OR ib.external_id=ib.account_id))))`;
    const people = db.prepare(visible).all(botJson, botJson, options.ownerId ?? '') as {
        id: string;
        display_name: string;
    }[];
    const entities = new Map<string, Entity>();
    const entity = (id: string, name: string, platform: 'twitch' | 'youtube') => { let e = entities.get(id); if (!e) {
        e = { id, name, source: platform, messages: 0, observedMinutes: 0, estimatedChatMinutes: 0, sessionIds: new Set(), intervals: [], donations: {}, core: false };
        entities.set(id, e);
    } return e; };
    const allowed = new Map(people.map(p => [p.id, p.display_name]));
    const samples = db.prepare('SELECT * FROM stream_samples WHERE session_id IN(SELECT value FROM json_each(?)) ORDER BY observed_at_ms').all(sessionIds) as any[];
    const segments: {
        session: string;
        categoryId: string;
        name: string;
        from: number;
        to: number;
    }[] = [];
    for (const s of sessions) {
        let start = Math.max(from, s.started_at_ms), end = Math.min(to, s.ended_at_ms ?? to), id = '', name = 'Категория неизвестна';
        for (const sample of samples.filter(x => x.session_id === s.id)) {
            if (sample.observed_at_ms < start) {
                id = sample.category_id;
                name = sample.category_name || 'Категория неизвестна';
                continue;
            }
            if (sample.observed_at_ms >= end)
                break;
            if (sample.category_id !== id || sample.category_name !== name) {
                if (sample.observed_at_ms > start)
                    segments.push({ session: s.id, categoryId: id, name, from: start, to: sample.observed_at_ms });
                start = sample.observed_at_ms;
                id = sample.category_id;
                name = sample.category_name || 'Категория неизвестна';
            }
        }
        if (end > start)
            segments.push({ session: s.id, categoryId: id, name, from: start, to: end });
    }
    const selected = segments.filter(s => !category || s.categoryId === category), contains = (sid: string, at: number) => selected.some(s => s.session === sid && at >= s.from && at < s.to);
    const clip = (span: Span) => selected.filter(s => s.session === span.session && s.from < span.to && s.to > span.from).map(s => ({ ...span, from: Math.max(span.from, s.from), to: Math.min(span.to, s.to) }));
    const sessionMessages = new Map<string, number>();
    const categoryAudience = new Map<string, Set<string>>();
    const categoryMessages = new Map<string, number>();
    const addMessages = (sid: string, at: number, n: number, id: string) => { const segment = selected.find(s => s.session === sid && at >= s.from && at < s.to); if (segment) {
        sessionMessages.set(sid, (sessionMessages.get(sid) ?? 0) + n);
        categoryMessages.set(segment.categoryId, (categoryMessages.get(segment.categoryId) ?? 0) + n);
        const ids = categoryAudience.get(segment.categoryId) ?? new Set();
        ids.add(id);
        categoryAudience.set(segment.categoryId, ids);
    } };
    const timeline = new Map<number, {
        at: number;
        messages: number;
        observed: number;
        estimated: number;
        viewers: number | null;
        twitchViewers: number | null;
        youtubeViewers: number | null;
        presenceKnown: boolean;
    }>();
    const minute = (at: number) => { at = Math.floor(at / 60000) * 60000; let row = timeline.get(at); if (!row) {
        row = { at, messages: 0, observed: 0, estimated: 0, viewers: null, twitchViewers: null, youtubeViewers: null, presenceKnown: false };
        timeline.set(at, row);
    } return row; };
    if (source !== 'youtube') {
        const intervals = db.prepare(`WITH raw AS(SELECT p.session_id,i.person_id,cast(max(p.started_at_ms,?,s.started_at_ms)/60000 AS INTEGER) AS lo,cast(min(p.completed_at_ms,?-1,coalesce(s.ended_at_ms,?)-1)/60000 AS INTEGER) AS hi FROM presence_polls p JOIN presence_members m ON m.poll_id=p.id JOIN identities i ON i.id=m.identity_id JOIN sessions s ON s.id=p.session_id WHERE p.status='complete' AND p.completed_at_ms>=? AND p.started_at_ms<? AND p.session_id IN(SELECT value FROM json_each(?))), prior AS(SELECT *,max(hi) OVER(PARTITION BY session_id,person_id ORDER BY lo,hi ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS previous_hi FROM raw WHERE hi>=lo),tagged AS(SELECT *,sum(CASE WHEN previous_hi IS NULL OR lo>previous_hi+1 THEN 1 ELSE 0 END) OVER(PARTITION BY session_id,person_id ORDER BY lo,hi) AS cluster FROM prior) SELECT session_id,person_id,min(lo)*60000 AS first_ms,(max(hi)+1)*60000 AS last_ms FROM tagged GROUP BY session_id,person_id,cluster LIMIT 50001`).all(from, to, to, from, to, sessionIds) as any[];
        if (intervals.length > 50000)
            throw new Error('ANALYTICS_RANGE_TOO_LARGE');
        for (const row of intervals) {
            const name = allowed.get(row.person_id);
            if (!name)
                continue;
            const e = entity(row.person_id, name, 'twitch');
            e.intervals.push(...clip({ from: row.first_ms, to: row.last_ms, session: row.session_id, kind: 'observed' }));
        }
        const messages = db.prepare(`SELECT i.person_id,es.session_id,min(e.occurred_at_ms) AS at,count(*) AS n,(SELECT c.category_id FROM stream_samples c WHERE c.session_id=es.session_id AND c.observed_at_ms<=e.occurred_at_ms ORDER BY c.observed_at_ms DESC LIMIT 1) AS cat FROM events e JOIN identities i ON i.id=e.identity_id JOIN event_sessions es ON es.event_id=e.id WHERE e.type='chat.message' AND e.occurred_at_ms>=? AND e.occurred_at_ms<? AND (json_extract(e.payload_json,'$.originChannelId') IS NULL OR json_extract(e.payload_json,'$.originChannelId')=e.account_id) AND es.session_id IN(SELECT value FROM json_each(?)) GROUP BY i.person_id,es.session_id,cast(e.occurred_at_ms/60000 AS INTEGER),cat LIMIT 50001`).all(from, to, sessionIds) as any[];
        if (messages.length > 50000)
            throw new Error('ANALYTICS_RANGE_TOO_LARGE');
        for (const row of messages) {
            const name = allowed.get(row.person_id);
            if (!name || !contains(row.session_id, row.at))
                continue;
            const e = entity(row.person_id, name, 'twitch');
            e.messages += row.n;
            e.sessionIds.add(row.session_id);
            minute(row.at).messages += row.n;
            addMessages(row.session_id, row.at, row.n, row.person_id);
        }
        const tips = db.prepare(`SELECT i.person_id,es.session_id,e.occurred_at_ms AS at,json_extract(e.payload_json,'$.currency') AS currency,json_extract(e.payload_json,'$.amountMinor') AS amount FROM events e JOIN identities i ON i.id=e.identity_id JOIN event_sessions es ON es.event_id=e.id WHERE e.type='donation' AND e.occurred_at_ms>=? AND e.occurred_at_ms<? AND es.session_id IN(SELECT value FROM json_each(?)) LIMIT 50001`).all(from, to, sessionIds) as any[];
        if (tips.length > 50000)
            throw new Error('ANALYTICS_RANGE_TOO_LARGE');
        for (const tip of tips) {
            const name = allowed.get(tip.person_id);
            if (!name || !contains(tip.session_id, tip.at) || !tip.currency || !/^\d+$/.test(tip.amount))
                continue;
            const e = entity(tip.person_id, name, 'twitch');
            e.donations[tip.currency] = (BigInt(e.donations[tip.currency] ?? '0') + BigInt(tip.amount)).toString();
            e.sessionIds.add(tip.session_id);
            addMessages(tip.session_id, tip.at, 0, tip.person_id);
        }
    }
    if (source !== 'twitch' && options.youtubeAccount) {
        const excludedAuthors = new Set((db.prepare(`SELECT DISTINCT author_id FROM youtube_messages WHERE account_id=? AND (json_extract(payload_json,'$.authorDetails.isChatOwner')=1 OR lower(ltrim(trim(json_extract(payload_json,'$.authorDetails.displayName')),'@#')) IN(SELECT value FROM json_each(?)))`).all(options.youtubeAccount,botJson) as {author_id:string}[]).map(row=>row.author_id));
        const chats = db.prepare(`WITH scoped AS (
    SELECT *, (SELECT s.id FROM sessions s WHERE s.started_at_ms<=m.published_at_ms AND coalesce(s.ended_at_ms,?)>m.published_at_ms ORDER BY s.started_at_ms DESC LIMIT 1) AS sid
    FROM youtube_messages m WHERE account_id=? AND author_id!=? AND author_id!='' AND published_at_ms>=? AND published_at_ms<? AND json_extract(payload_json,'$.snippet.type') IN('textMessageEvent','superChatEvent','superStickerEvent')
  ), categorized AS (
    SELECT *, (SELECT c.category_id FROM stream_samples c WHERE c.session_id=scoped.sid AND c.observed_at_ms<=scoped.published_at_ms ORDER BY c.observed_at_ms DESC LIMIT 1) AS cat FROM scoped
  ) SELECT author_id,max(json_extract(payload_json,'$.authorDetails.displayName')) AS name,min(published_at_ms) AS at,max(published_at_ms) AS last_at,sum(CASE WHEN published_at_ms>=? THEN 1 ELSE 0 END) AS n,min(CASE WHEN published_at_ms>=? THEN published_at_ms END) AS message_at,sid,cat FROM categorized GROUP BY author_id,cast(published_at_ms/60000 AS INTEGER),sid,cat LIMIT 50001`).all(to, options.youtubeAccount, options.youtubeAccount, Math.max(0,from-window*60000), to, from, from) as any[];
        if (chats.length > 50000)
            throw new Error('ANALYTICS_RANGE_TOO_LARGE');
        for (const chat of chats) {
            if (excludedAuthors.has(chat.author_id) || isExcludedBot(chat.name ?? '', excluded) || !chat.sid)
                continue;
            const e = entity(`youtube:${chat.author_id}`, chat.name || chat.author_id, 'youtube');
            const spans=clip({ from: chat.at, to: Math.min(to, chat.last_at + window * 60000), session: chat.sid, kind: 'chat_proxy' });
            if (chat.n && contains(chat.sid,chat.message_at)) {
                e.messages += chat.n;
                e.sessionIds.add(chat.sid);
                minute(chat.message_at).messages += chat.n;
                addMessages(chat.sid, chat.message_at, chat.n, `youtube:${chat.author_id}`);
            }
            e.intervals.push(...spans);
        }
    }
    let expanded = 0;
    // Materialize the selected recording interval, including empty samples and gaps.
    for (const segment of selected) for (let at = Math.floor(segment.from / 60000) * 60000; at < segment.to; at += 60000) {
        if (++expanded > 2000000) throw new Error('ANALYTICS_RANGE_TOO_LARGE');
        minute(at);
    }
    for (const e of entities.values()) {
        e.intervals = unionSpans(e.intervals);
        for (const span of e.intervals) {
            const duration = (span.to - span.from) / 60000;
            if (span.kind === 'observed')
                e.observedMinutes += duration;
            else
                e.estimatedChatMinutes += duration;
            e.sessionIds.add(span.session);
            for (let at = Math.floor(span.from / 60000) * 60000; at < span.to; at += 60000) {
                if (++expanded > 2000000)
                    throw new Error('ANALYTICS_RANGE_TOO_LARGE');
                const point = minute(at);
                if (span.kind === 'observed')
                    point.observed++;
                else
                    point.estimated++;
            }
        }
        const long = e.observedMinutes + e.estimatedChatMinutes >= minMinutes, chatty = e.messages >= minMessages;
        e.core = e.sessionIds.size >= minSessions && (rule === 'frequency' || (rule === 'both' ? long && chatty : long || chatty));
    }
    const categories = new Map<string, {
        id: string;
        name: string;
        minutes: number;
        messages: number;
        observedMinutes: number;
        observedKnownMinutes: number;
        estimatedChatMinutes: number;
        sessions: Set<string>;
        audience: Set<string>;
        core: Set<string>;
    }>();
    for (const segment of selected) {
        let c = categories.get(segment.categoryId);
        if (!c) {
            c = { id: segment.categoryId, name: segment.name, minutes: 0, messages: 0, observedMinutes: 0, observedKnownMinutes: 0, estimatedChatMinutes: 0, sessions: new Set(), audience: new Set(categoryAudience.get(segment.categoryId) ?? []), core: new Set([...(categoryAudience.get(segment.categoryId) ?? [])].filter(id => entities.get(id)?.core)) };
            categories.set(segment.categoryId, c);
        }
        c.minutes += (segment.to - segment.from) / 60000;
        c.sessions.add(segment.session);
        for (const e of entities.values()) {
            let duration = 0;
            for (const span of e.intervals)
                if (span.session === segment.session)
                    duration += Math.max(0, Math.min(span.to, segment.to) - Math.max(span.from, segment.from)) / 60000;
            if (duration) {
                c.audience.add(e.id);
                if (e.core)
                    c.core.add(e.id);
                if (e.source === 'twitch')
                    c.observedMinutes += duration;
                else
                    c.estimatedChatMinutes += duration;
            }
        }
    }
    for (const c of categories.values())
        c.messages = categoryMessages.get(c.id) ?? 0;
    for (const sample of samples)
        if (contains(sample.session_id, sample.observed_at_ms)) {
            const point = minute(sample.observed_at_ms);
            if(sample.twitch_viewers !== null)point.twitchViewers=sample.twitch_viewers;
            if(sample.youtube_viewers !== null)point.youtubeViewers=sample.youtube_viewers;
            point.viewers = source === 'twitch' ? point.twitchViewers : source === 'youtube' ? point.youtubeViewers : point.twitchViewers === null || point.youtubeViewers === null ? null : point.twitchViewers + point.youtubeViewers;
        }
    const coverage = db.prepare("SELECT session_id,started_at_ms AS first,completed_at_ms AS last FROM presence_polls WHERE status='complete' AND completed_at_ms>=? AND started_at_ms<? AND session_id IN(SELECT value FROM json_each(?))").all(from, to, sessionIds) as any[];
    for (const poll of coverage)
        for (const span of clip({ from: Math.floor(poll.first / 60000) * 60000, to: (Math.floor(poll.last / 60000) + 1) * 60000, session: poll.session_id, kind: 'observed' }))
            for (let at = Math.floor(span.from / 60000) * 60000; at < span.to; at += 60000) {
                if (++expanded > 2000000)
                    throw new Error('ANALYTICS_RANGE_TOO_LARGE');
                minute(at).presenceKnown = true;
            }
    for (const segment of selected) {
        const c=categories.get(segment.categoryId)!;
        for (let at=Math.floor(segment.from/60000)*60000;at<segment.to;at+=60000) if(timeline.get(at)?.presenceKnown) c.observedKnownMinutes+=Math.max(0,Math.min(at+60000,segment.to)-Math.max(at,segment.from))/60000;
    }
    const hourly = new Map<string, {
        day: string;
        hour: number;
        observed: number;
        estimated: number;
        messages: number;
        sampleMinutes: number;
        observedKnownMinutes: number;
        viewersTotal: number;
        viewerSamples: number;
    }>();
    for (const point of timeline.values()) {
        const parts = clock.formatToParts(point.at), day = parts.find(x => x.type === 'weekday')!.value, hour = Number(parts.find(x => x.type === 'hour')!.value), key = `${day}:${hour}`;
        let cell = hourly.get(key);
        if (!cell) {
            cell = { day, hour, observed: 0, estimated: 0, messages: 0, sampleMinutes: 0, observedKnownMinutes: 0, viewersTotal: 0, viewerSamples: 0 };
            hourly.set(key, cell);
        }
        cell.observed += point.observed;
        cell.estimated += point.estimated;
        cell.messages += point.messages;
        cell.sampleMinutes++;
        if(point.viewers !== null) {cell.viewersTotal+=point.viewers;cell.viewerSamples++;}
        if (point.presenceKnown)
            cell.observedKnownMinutes++;
    }
    const audience = [...entities.values()].filter(e => e.sessionIds.size || e.messages).sort((a, b) => Number(b.core) - Number(a.core) || b.observedMinutes - a.observedMinutes || b.messages - a.messages).map(e => ({ ...e, sessionIds: [...e.sessionIds], visits: e.intervals.length, observedMinutesPerSession: e.sessionIds.size ? e.observedMinutes/e.sessionIds.size : 0, sessionRatio: e.sessionIds.size/new Set(selected.map(s=>s.session)).size, observedMinutes: Math.round(e.observedMinutes * 10) / 10, estimatedChatMinutes: Math.round(e.estimatedChatMinutes * 10) / 10 }));
    const seen = new Set<string>();
    const streamComparison = sessions.filter(s => selected.some(segment => segment.session === s.id)).map(s => {
        const visitors = audience.filter(e => e.sessionIds.includes(s.id)), newInPeriod = visitors.filter(e => !seen.has(e.id)).length;
        for (const e of visitors)
            seen.add(e.id);
        return { id: s.id, startedAt: s.started_at_ms, endedAt: s.ended_at_ms ?? to, title: samples.find(x => x.session_id === s.id)?.title ?? "", audience: visitors.length, core: visitors.filter(e => e.core).length, newInPeriod, returning: visitors.length - newInPeriod, messages: sessionMessages.get(s.id) ?? 0, categories: [...new Set(selected.filter(segment => segment.session === s.id).map(segment => segment.name))] };
    });
    const report=source!=='twitch'&&options.youtubeAccount ? db.prepare("SELECT payload_json,updated_at_ms FROM youtube_snapshots WHERE account_id=? AND key='report'").get(options.youtubeAccount) as {payload_json:string;updated_at_ms:number}|undefined : undefined;
    const youtubeReport=report ? {data:JSON.parse(report.payload_json),updatedAt:report.updated_at_ms} : null;
    return { youtubeReport, streamComparison, availableCategories: [...new Map(segments.map(s => [s.categoryId, { id: s.categoryId, name: s.name }])).values()], filters: { fromMs: from, toMs: to, source, category, minSessions, minMinutes, minMessages, coreRule: rule, chatWindowMinutes: window, timezone }, summary: { entities: audience.length, core: audience.filter(e => e.core).length, streams: new Set(selected.map(x => x.session)).size, messages: audience.reduce((sum, e) => sum + e.messages, 0) }, audience, categories: [...categories.values()].map(c => ({ ...c, sessions: c.sessions.size, audience: c.audience.size, core: c.core.size, messagesPerHour: c.minutes ? c.messages * 60 / c.minutes : 0, observedPerMinute: c.minutes ? c.observedMinutes / c.minutes : 0, observedPerKnownMinute: c.observedKnownMinutes ? c.observedMinutes / c.observedKnownMinutes : null, coverageRatio: c.minutes ? c.observedKnownMinutes/c.minutes : null })), timeline: [...timeline.values()].sort((a, b) => a.at - b.at), hours: [...hourly.values()].sort((a, b) => ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].indexOf(a.day) - ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].indexOf(b.day) || a.hour - b.hour), sessions, excluded: [...excluded] };
}
