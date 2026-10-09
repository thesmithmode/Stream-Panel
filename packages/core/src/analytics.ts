import type Database from 'better-sqlite3';
import { botExclusionSet, isExcludedBot } from './bots.js';
export interface AnalyticsOptions {
    fromMs: number;
    toMs: number;
    source?: 'all' | 'twitch' | 'youtube';
    category?: string;
    minSessions?: number;
    regularThresholdPercent?: number;
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
    sources: ('twitch' | 'youtube')[];
    messages: number;
    observedMinutes: number;
    estimatedChatMinutes: number;
    sessionIds: Set<string>;
    attendanceSessionIds: Set<string>;
    regular: boolean;
    intervals: Span[];
    donations: Record<string, string>;
    core: boolean;
    tags: string[];
    manualCore: boolean|null;
};
export function unionSpans(spans: Span[]): Span[] {
    const sorted = spans.filter(x => x.to > x.from).sort((a, b) => a.session.localeCompare(b.session) || a.kind.localeCompare(b.kind) || a.from - b.from || a.to - b.to), out: Span[] = [];
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
    const regularThresholdPercent=options.regularThresholdPercent??50;
    const minSessions = options.minSessions ?? 3, minMinutes = options.minMinutes ?? 30, minMessages = options.minMessages ?? 5, window = options.chatWindowMinutes ?? 5, rule = options.coreRule ?? 'either';
    if (!Number.isFinite(regularThresholdPercent) || regularThresholdPercent<0 || regularThresholdPercent>100 || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > 8640000000000000 || !['all', 'twitch', 'youtube'].includes(source) || !['either', 'both', 'frequency'].includes(rule) || category.length > 256 || [minSessions, minMinutes, minMessages, window].some(n => !Number.isInteger(n) || n < 0) || minSessions > 1000 || minMinutes > 129600 || minMessages > 1000000 || window < 1 || window > 30)
        throw new Error('INVALID_ANALYTICS_FILTER');
    let clock: Intl.DateTimeFormat;
    try {
        clock = new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
    }
    catch {
        throw new Error('INVALID_TIMEZONE');
    }
    const excluded = botExclusionSet(['fullrandomname_twitch', ...(options.excludedLogins ?? [])]), botJson = JSON.stringify([...excluded]);
    const sessions = db.prepare('SELECT * FROM sessions WHERE NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=sessions.id) AND started_at_ms<? AND coalesce(ended_at_ms,?)>? ORDER BY started_at_ms LIMIT 1001').all(to, to, from) as any[];
    if (sessions.length > 1000)
        throw new Error('ANALYTICS_RANGE_TOO_LARGE');
    const sessionIds = JSON.stringify(sessions.map(s => s.id));
    const visible = `SELECT p.id,p.display_name FROM persons p WHERE NOT EXISTS(SELECT 1 FROM identities ib WHERE ib.person_id=p.id AND (ib.match_key IN(SELECT value FROM json_each(?)) OR EXISTS(SELECT 1 FROM identity_aliases a WHERE a.identity_id=ib.id AND ltrim(a.candidate_key,'@#') IN(SELECT value FROM json_each(?))) OR (ib.source='twitch' AND (ib.external_id=? OR ib.external_id=ib.account_id)))) AND NOT EXISTS(SELECT 1 FROM youtube_identities y LEFT JOIN youtube_identity_aliases a ON a.identity_id=y.id WHERE y.person_id=p.id AND (y.is_owner=1 OR y.external_id=y.account_id OR y.match_key IN(SELECT value FROM json_each(?)) OR a.match_key IN(SELECT value FROM json_each(?))))`;
    const people = db.prepare(visible).all(botJson, botJson, options.ownerId ?? '', botJson,botJson) as {
        id: string;
        display_name: string;
    }[];
    const entities = new Map<string, Entity>();
    const entity = (id: string, name: string, platform: 'twitch' | 'youtube') => { let e = entities.get(id); if (!e) {
        e = { id, name, source: platform, sources:[platform], messages: 0, observedMinutes: 0, estimatedChatMinutes: 0, sessionIds: new Set(), attendanceSessionIds: new Set(), regular: false, intervals: [], donations: {}, core: false, tags:[], manualCore:null };
        entities.set(id, e);
    } else if(!e.sources.includes(platform)) e.sources.push(platform); return e; };
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
        for (const sample of samples.filter(x => x.session_id === s.id && (x.twitch_viewers !== null || x.category_id || x.category_name))) {
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
    const selectedStreamCount=new Set(selected.map(segment=>segment.session)).size;
    const messageAuthors=new Map<number,Map<string,number>>();
    const sessionMessages = new Map<string, number>();
    const categoryAudience = new Map<string, Set<string>>();
    const categoryMessages = new Map<string, number>();
    const addMessages = (sid: string, at: number, n: number, id: string) => { const segment = selected.find(s => s.session === sid && at >= s.from && at < s.to); if (segment) {
        if(n>0){const atMinute=Math.floor(at/60000)*60000,authors=messageAuthors.get(atMinute)??new Map<string,number>();authors.set(id,(authors.get(id)??0)+n);messageAuthors.set(atMinute,authors);}
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
        regularObserved: number;
        regularEstimated: number;
        regularMessages: number;
        viewers: number | null;
        twitchViewers: number | null;
        youtubeViewers: number | null;
        presenceKnown: boolean;
    }>();
    const minute = (at: number) => { at = Math.floor(at / 60000) * 60000; let row = timeline.get(at); if (!row) {
        row = { at, messages: 0, observed: 0, estimated: 0, regularObserved: 0, regularEstimated: 0, regularMessages: 0, viewers: null, twitchViewers: null, youtubeViewers: null, presenceKnown: false };
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
        const messages = db.prepare(`SELECT i.person_id,es.session_id,min(e.occurred_at_ms) AS at,count(*) AS n,(SELECT c.category_id FROM stream_samples c WHERE c.session_id=es.session_id AND c.observed_at_ms<=e.occurred_at_ms ORDER BY c.observed_at_ms DESC LIMIT 1) AS cat FROM effective_events e JOIN identities i ON i.id=e.identity_id JOIN event_sessions es ON es.event_id=e.id WHERE e.type='chat.message' AND e.occurred_at_ms>=? AND e.occurred_at_ms<? AND (json_extract(e.payload_json,'$.originChannelId') IS NULL OR json_extract(e.payload_json,'$.originChannelId')=e.account_id) AND es.session_id IN(SELECT value FROM json_each(?)) GROUP BY i.person_id,es.session_id,cast(e.occurred_at_ms/60000 AS INTEGER),cat LIMIT 50001`).all(from, to, sessionIds) as any[];
        if (messages.length > 50000)
            throw new Error('ANALYTICS_RANGE_TOO_LARGE');
        for (const row of messages) {
            const name = allowed.get(row.person_id);
            if (!name || !contains(row.session_id, row.at))
                continue;
            const e = entity(row.person_id, name, 'twitch');
            e.messages += row.n;
            e.sessionIds.add(row.session_id);
            e.attendanceSessionIds.add(row.session_id);
            minute(row.at).messages += row.n;
            addMessages(row.session_id, row.at, row.n, row.person_id);
        }
        const tips = db.prepare(`SELECT i.person_id,es.session_id,e.occurred_at_ms AS at,json_extract(e.payload_json,'$.currency') AS currency,json_extract(e.payload_json,'$.amountMinor') AS amount FROM effective_events e JOIN identities i ON i.id=e.identity_id JOIN event_sessions es ON es.event_id=e.id WHERE e.type='donation' AND e.occurred_at_ms>=? AND e.occurred_at_ms<? AND es.session_id IN(SELECT value FROM json_each(?)) LIMIT 50001`).all(from, to, sessionIds) as any[];
        if (tips.length > 50000)
            throw new Error('ANALYTICS_RANGE_TOO_LARGE');
        for (const tip of tips) {
            const name = allowed.get(tip.person_id);
            if (!name || !contains(tip.session_id, tip.at) || !tip.currency || !/^\d+$/.test(tip.amount))
                continue;
            const e = entity(tip.person_id, name, 'twitch');
            e.donations[tip.currency] = (BigInt(e.donations[tip.currency] ?? '0') + BigInt(tip.amount)).toString();
            e.sessionIds.add(tip.session_id);

        }
    }
    if (source !== 'twitch' && options.youtubeAccount) {
        const personLinks=new Map((db.prepare('SELECT external_id,person_id FROM youtube_identities WHERE account_id=?').all(options.youtubeAccount) as {external_id:string;person_id:string}[]).map(row=>[row.external_id,row.person_id]));
        const excludedAuthors = new Set((db.prepare(`SELECT DISTINCT author_id FROM youtube_messages WHERE account_id=? AND (json_extract(payload_json,'$.authorDetails.isChatOwner')=1 OR lower(ltrim(trim(json_extract(payload_json,'$.authorDetails.displayName')),'@#')) IN(SELECT value FROM json_each(?)))`).all(options.youtubeAccount,botJson) as {author_id:string}[]).map(row=>row.author_id));
        const chats = db.prepare(`WITH scoped AS (
    SELECT *, (SELECT ps.session_id FROM platform_streams ps JOIN sessions s ON s.id=ps.session_id WHERE ps.platform='youtube' AND ps.account_id=m.account_id AND ps.started_at_ms<=m.published_at_ms AND coalesce(ps.ended_at_ms,s.ended_at_ms,?)>m.published_at_ms ORDER BY ps.started_at_ms DESC LIMIT 1) AS sid
    FROM youtube_messages m WHERE account_id=? AND author_id!=? AND author_id!='' AND published_at_ms>=? AND published_at_ms<? AND json_extract(payload_json,'$.snippet.type') IN('textMessageEvent','superChatEvent','superStickerEvent')
  ), categorized AS (
    SELECT *, (SELECT c.category_id FROM stream_samples c WHERE c.session_id=scoped.sid AND c.observed_at_ms<=scoped.published_at_ms ORDER BY c.observed_at_ms DESC LIMIT 1) AS cat FROM scoped
  ) SELECT author_id,max(json_extract(payload_json,'$.authorDetails.displayName')) AS name,min(published_at_ms) AS at,max(published_at_ms) AS last_at,sum(CASE WHEN published_at_ms>=? THEN 1 ELSE 0 END) AS n,min(CASE WHEN published_at_ms>=? THEN published_at_ms END) AS message_at,sid,cat FROM categorized GROUP BY author_id,cast(published_at_ms/60000 AS INTEGER),sid,cat LIMIT 50001`).all(to, options.youtubeAccount, options.youtubeAccount, Math.max(0,from-window*60000), to, from, from) as any[];
        if (chats.length > 50000)
            throw new Error('ANALYTICS_RANGE_TOO_LARGE');
        for (const chat of chats) {
            if (excludedAuthors.has(chat.author_id) || isExcludedBot(chat.name ?? '', excluded) || !chat.sid)
                continue;
            const personId=personLinks.get(chat.author_id);
            if(!personId||!allowed.has(personId))continue;
            const e = entity(personId, allowed.get(personId)!, 'youtube');
            const spans=clip({ from: chat.at, to: Math.min(to, chat.last_at + window * 60000), session: chat.sid, kind: 'chat_proxy' });
            if (chat.n && contains(chat.sid,chat.message_at)) {
                e.messages += chat.n;
                e.sessionIds.add(chat.sid);
                e.attendanceSessionIds.add(chat.sid);
                minute(chat.message_at).messages += chat.n;
                addMessages(chat.sid, chat.message_at, chat.n, e.id);
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
    const entityIds=JSON.stringify([...entities.keys()]);
    const preferences=new Map((db.prepare("SELECT person_id,manual_core FROM person_preferences WHERE person_id IN(SELECT value FROM json_each(?))").all(entityIds) as {person_id:string;manual_core:number|null}[]).map(row=>[row.person_id,row.manual_core]));
    const tags=db.prepare(`WITH RECURSIVE owners(person_id,origin_id) AS (SELECT value,value FROM json_each(?) UNION SELECT o.person_id,m.source_person_id FROM owners o JOIN person_merges m ON m.target_person_id=o.origin_id WHERE m.undone_at_ms IS NULL) SELECT DISTINCT o.person_id,t.label FROM owners o JOIN person_tags t ON t.person_id=o.origin_id ORDER BY t.label`).all(entityIds) as {person_id:string;label:string}[];
    for(const tag of tags)entities.get(tag.person_id)!.tags.push(tag.label);
    for (const e of entities.values()) {
        e.intervals = unionSpans(e.intervals);
        for(const span of e.intervals)e.attendanceSessionIds.add(span.session);
        for(const span of e.intervals){
            const duration=(span.to-span.from)/60000;
            if(span.kind==='observed')e.observedMinutes+=duration;else e.estimatedChatMinutes+=duration;
            e.sessionIds.add(span.session);
        }
        const activityMinutes=unionSpans(e.intervals.map(span=>({...span,kind:'observed' as const}))).reduce((sum,span)=>sum+(span.to-span.from)/60000,0);
        const long=activityMinutes>=minMinutes,chatty=e.messages>=minMessages;
        const automatic=e.attendanceSessionIds.size>=minSessions && e.attendanceSessionIds.size>0 && e.attendanceSessionIds.size/selectedStreamCount*100>regularThresholdPercent && (rule==='frequency'||(rule==='both'?long&&chatty:long||chatty));
        const override=preferences.get(e.id);
        e.manualCore=override==null?null:override===1;
        e.core=e.manualCore??automatic;
        e.regular=e.core; // Compatibility fields refer to the same audience core.
        const signalMinutes=new Set<string>();
        for (const span of e.intervals) {
            for (let at = Math.floor(span.from / 60000) * 60000; at < span.to; at += 60000) {
                if (++expanded > 2000000)
                    throw new Error('ANALYTICS_RANGE_TOO_LARGE');
                const signalKey=`${span.kind}:${at}`;
                if(signalMinutes.has(signalKey))continue;
                signalMinutes.add(signalKey);
                const point = minute(at);
                if (span.kind === 'observed'){point.observed++;if(e.regular)point.regularObserved++;}
                else {point.estimated++;if(e.regular)point.regularEstimated++;}
            }
        }
    }
    for(const [at,authors] of messageAuthors)for(const [id,n] of authors)if(entities.get(id)?.regular)minute(at).regularMessages+=n;
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
            let observed = 0, estimated = 0;
            for (const span of e.intervals)
                if (span.session === segment.session) {
                    const duration=Math.max(0, Math.min(span.to, segment.to) - Math.max(span.from, segment.from)) / 60000;
                    if(span.kind==='observed')observed+=duration;else estimated+=duration;
                }
            if (observed+estimated) {
                c.audience.add(e.id);
                if (e.core)
                    c.core.add(e.id);
                c.observedMinutes += observed;
                c.estimatedChatMinutes += estimated;
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
    const audience = [...entities.values()].filter(e => e.sessionIds.size || e.messages).sort((a, b) => Number(b.core) - Number(a.core) || b.observedMinutes - a.observedMinutes || b.messages - a.messages).map(e => ({ ...e, sessionIds: [...e.sessionIds], attendanceSessionIds: [...e.attendanceSessionIds], attendanceRatio: selectedStreamCount?e.attendanceSessionIds.size/selectedStreamCount:0, visits: e.intervals.length, observedMinutesPerSession: e.attendanceSessionIds.size ? e.observedMinutes/e.attendanceSessionIds.size : 0, sessionRatio: e.sessionIds.size/selectedStreamCount, observedMinutes: Math.round(e.observedMinutes * 10) / 10, estimatedChatMinutes: Math.round(e.estimatedChatMinutes * 10) / 10 }));
    const attendees=audience.filter(e=>e.attendanceSessionIds.length>0),regulars=audience.filter(e=>e.core).length;
    const seen = new Set<string>();
    const streamComparison = sessions.filter(s => selected.some(segment => segment.session === s.id)).map(s => {
        const visitors = audience.filter(e => e.attendanceSessionIds.includes(s.id)), newInPeriod = visitors.filter(e => !seen.has(e.id)).length;
        for (const e of visitors)
            seen.add(e.id);
        return { id: s.id, startedAt: s.started_at_ms, endedAt: s.ended_at_ms ?? to, title: samples.find(x => x.session_id === s.id)?.title ?? "", audience: visitors.length, core: visitors.filter(e => e.core).length, newInPeriod, returning: visitors.length - newInPeriod, messages: sessionMessages.get(s.id) ?? 0, categories: [...new Set(selected.filter(segment => segment.session === s.id).map(segment => segment.name))] };
    });
    const report=source!=='twitch'&&options.youtubeAccount ? db.prepare("SELECT payload_json,updated_at_ms FROM youtube_snapshots WHERE account_id=? AND key='report'").get(options.youtubeAccount) as {payload_json:string;updated_at_ms:number}|undefined : undefined;
    const youtubeReport=report ? {data:JSON.parse(report.payload_json),updatedAt:report.updated_at_ms} : null;
    return { youtubeReport, streamComparison, availableCategories: [...new Map(segments.map(s => [s.categoryId, { id: s.categoryId, name: s.name }])).values()], filters: { fromMs: from, toMs: to, source, category, minSessions, minMinutes, minMessages, regularThresholdPercent, coreRule: rule, chatWindowMinutes: window, timezone }, summary: { entities: audience.length, attendees: attendees.length, regulars, regularShare: audience.length?regulars/audience.length:null, core: audience.filter(e => e.core).length, streams: new Set(selected.map(x => x.session)).size, messages: audience.reduce((sum, e) => sum + e.messages, 0) }, audience, categories: [...categories.values()].map(c => ({ ...c, sessions: c.sessions.size, audience: c.audience.size, core: c.core.size, messagesPerHour: c.minutes ? c.messages * 60 / c.minutes : 0, observedPerMinute: c.minutes ? c.observedMinutes / c.minutes : 0, observedPerKnownMinute: c.observedKnownMinutes ? c.observedMinutes / c.observedKnownMinutes : null, coverageRatio: c.minutes ? c.observedKnownMinutes/c.minutes : null })), timeline: [...timeline.values()].sort((a, b) => a.at - b.at), hours: [...hourly.values()].sort((a, b) => ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].indexOf(a.day) - ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].indexOf(b.day) || a.hour - b.hour), sessions, excluded: [...excluded] };
}
