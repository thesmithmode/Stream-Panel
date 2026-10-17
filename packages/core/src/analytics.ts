import {clockActivity} from './clock-activity.js';
import {donationTiming} from './donation-statistics.js';
import {timePatterns} from './time-patterns.js';
import type Database from 'better-sqlite3';
import {currencyRates} from './rates.js';
import {streamMetrics} from './stream-metrics.js';
import {windowsFromLinks,sessionBreaks} from './session-windows.js';
import { botExclusionSet, isExcludedBot } from './bots.js';
export interface AnalyticsOptions {
    fromMs: number;
    toMs: number;
    source?: 'all' | 'twitch' | 'youtube';
    category?: string;
    sessionId?: string;
    summaryOnly?: boolean;
    audienceOffset?:number;
    audienceSearch?:string;
    audienceSort?:string;
    audienceCoreOnly?:boolean;
    clockDay?:string;
    clockMinute?:number;
    clockResolution?:number;
    clockOffset?:number;
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
    follower:boolean|null;
    arrivalHours:{day:string;hour:number;visits:number}[];
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
function groupBySession<T extends {session_id:string}>(rows:T[]):Map<string,T[]> {
    const groups=new Map<string,T[]>();
    for(const row of rows){const group=groups.get(row.session_id);if(group)group.push(row);else groups.set(row.session_id,[row]);}
    return groups;
}
export function validateAnalyticsOptions(options:AnalyticsOptions,from=options.fromMs,to=options.toMs){
    if([options.audienceOffset,options.clockOffset].some(n=>n!==undefined&&(!Number.isSafeInteger(n)||n<0)) ||
       (options.audienceSearch!==undefined&&(typeof options.audienceSearch!=='string'||options.audienceSearch.length>256)) ||
       (options.audienceSort!==undefined&&!['core','sessions','observedMinutes','estimatedChatMinutes','messages','attendanceRatio'].includes(options.audienceSort)) ||
       (options.clockDay!==undefined&&!['all','weekdays','weekends','пн','вт','ср','чт','пт','сб','вс'].includes(options.clockDay)) ||
       (options.clockResolution!==undefined&&![1,5,15,60].includes(options.clockResolution)) ||
       (options.clockMinute!==undefined&&(!Number.isInteger(options.clockMinute)||options.clockMinute<0||options.clockMinute>=1440||options.clockMinute%(options.clockResolution??60)!==0)))throw new Error('INVALID_ANALYTICS_FILTER');
    const source = options.source ?? 'all', category = options.category ?? '', timezone = options.timezone ?? 'Europe/Moscow';
    const regularThresholdPercent=options.regularThresholdPercent??80;
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
    return {source,category,timezone,regularThresholdPercent,minSessions,minMinutes,minMessages,window,rule,clock};
}
export function audienceAnalytics(db: Database.Database, options: AnalyticsOptions) {
    const recording=options.sessionId?db.prepare('SELECT started_at_ms,ended_at_ms FROM sessions WHERE id=? AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=sessions.id)').get(options.sessionId) as {started_at_ms:number;ended_at_ms:number|null}|undefined:undefined;
    if(options.sessionId&&!recording)throw new Error('SESSION_NOT_FOUND');
    const from=recording?Math.max(options.fromMs,recording.started_at_ms):options.fromMs,to=recording?Math.min(options.toMs,recording.ended_at_ms??options.toMs):options.toMs;
    const {source,category,timezone,regularThresholdPercent,minSessions,minMinutes,minMessages,window,rule,clock}=validateAnalyticsOptions(options,from,to);
    const excluded = botExclusionSet(options.excludedLogins ?? []), botJson = JSON.stringify([...excluded]);
    const sessions = db.prepare('SELECT * FROM sessions WHERE NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=sessions.id) AND started_at_ms<? AND coalesce(ended_at_ms,?)>? AND (? IS NULL OR id=?) ORDER BY started_at_ms LIMIT 1001').all(to, to, from, options.sessionId??null,options.sessionId??null) as any[];
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
        e = { id, name, source: platform, sources:[platform], messages: 0, observedMinutes: 0, estimatedChatMinutes: 0, sessionIds: new Set(), attendanceSessionIds: new Set(), regular: false, intervals: [], donations: {}, core: false, tags:[], manualCore:null, follower:null,arrivalHours:[] };
        entities.set(id, e);
    } else if(!e.sources.includes(platform)) e.sources.push(platform); return e; };
    const allowed = new Map(people.map(p => [p.id, p.display_name]));
    const platformWindows=db.prepare('SELECT session_id,platform,started_at_ms,ended_at_ms FROM platform_streams WHERE session_id IN(SELECT value FROM json_each(?))').all(sessionIds) as {session_id:string;platform:string;started_at_ms:number;ended_at_ms:number|null}[];
    const samples = db.prepare('SELECT * FROM stream_samples WHERE session_id IN(SELECT value FROM json_each(?)) ORDER BY observed_at_ms').all(sessionIds) as any[];
    const samplesBySession=groupBySession(samples),platformsBySession=groupBySession(platformWindows);
    const windows=(id:string,start:number,end:number)=>windowsFromLinks(platformsBySession.get(id)??[],start,end);
    const segments: {
        session: string;
        categoryId: string;
        name: string;
        from: number;
        to: number;
    }[] = [];
    for (const s of sessions) {
        let start = Math.max(from, s.started_at_ms), end = Math.min(to, s.ended_at_ms ?? to), id = '', name = 'Категория неизвестна';
        for (const sample of (samplesBySession.get(s.id)??[]).filter(x => x.twitch_viewers !== null || x.category_id || x.category_name)) {
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
    const breaks=sessions.flatMap(s=>sessionBreaks(windows(s.id,s.started_at_ms,Math.min(to,s.ended_at_ms??to))).map(span=>({...span,session:s.id})));
    const liveSegments=segments.flatMap(segment=>windows(segment.session,segment.from,segment.to).map(span=>({...segment,...span})));
    const selected = liveSegments.filter(s => !category || s.categoryId === category);
    const selectedBySession=new Map<string,typeof selected>();
    for(const segment of selected){const group=selectedBySession.get(segment.session);if(group)group.push(segment);else selectedBySession.set(segment.session,[segment]);}
    const segmentAt=(sid:string,at:number)=>(selectedBySession.get(sid)??[]).find(s=>at>=s.from&&at<s.to);
    const contains = (sid: string, at: number) => segmentAt(sid,at)!==undefined;
    const clip = (span: Span) => (selectedBySession.get(span.session)??[]).filter(s => s.from < span.to && s.to > span.from).map(s => ({ ...span, from: Math.max(span.from, s.from), to: Math.min(span.to, s.to) }));
    const selectedStreamCount=new Set(selected.map(segment=>segment.session)).size;
    const platformMessageAuthors={twitch:new Map<number,Map<string,number>>(),youtube:new Map<number,Map<string,number>>()};
    const streamAuthors=new Map<string,Map<number,Set<string>>>();
    const sessionMessages = new Map<string, number>();
    const categoryAudience = new Map<string, Set<string>>();
    const categoryMessages = new Map<string, number>();
    const categoryDonations=new Map<string,Record<string,string>>(),streamDonations=new Map<string,Record<string,string>>();
    const categoryDonationCounts=new Map<string,number>(),streamDonationCounts=new Map<string,number>();
    const minuteDonations=new Map<number,Record<string,string>>(),minuteDonationCounts=new Map<number,number>();
    const addDonation=(totals:Map<string,Record<string,string>>,counts:Map<string,number>,key:string,currency:string,amount:string)=>{
        const values=totals.get(key)??{};values[currency]=(BigInt(values[currency]??'0')+BigInt(amount)).toString();totals.set(key,values);counts.set(key,(counts.get(key)??0)+1);
    };
    const addMessages = (sid: string, at: number, n: number, id: string, platform: 'twitch'|'youtube') => { const segment = segmentAt(sid,at); if (segment) {
        if(n>0){const atMinute=Math.floor(at/60000)*60000;
            const platformAuthors=platformMessageAuthors[platform].get(atMinute)??new Map<string,number>();platformAuthors.set(id,(platformAuthors.get(id)??0)+n);platformMessageAuthors[platform].set(atMinute,platformAuthors);
            const minutes=streamAuthors.get(sid)??new Map<number,Set<string>>(),ids=minutes.get(atMinute)??new Set<string>();ids.add(id);minutes.set(atMinute,ids);streamAuthors.set(sid,minutes);
        }
        sessionMessages.set(sid, (sessionMessages.get(sid) ?? 0) + n);
        categoryMessages.set(segment.categoryId, (categoryMessages.get(segment.categoryId) ?? 0) + n);
        const ids = categoryAudience.get(segment.categoryId) ?? new Set();
        ids.add(id);
        categoryAudience.set(segment.categoryId, ids);
    } };
    const timeline = new Map<number, {
        at: number;
        messages: number;
        twitchMessages:number;youtubeMessages:number;regularTwitchMessages:number;regularYoutubeMessages:number;followerTwitchMessages:number;followerYoutubeMessages:number;unknownMessages:number;unknownTwitchMessages:number;unknownYoutubeMessages:number;
        observed: number;
        estimated: number;
        regularObserved: number;
        regularEstimated: number;
        regularMessages: number;
        participants:number; regularParticipants:number; followerParticipants:number; followerObserved:number; followerEstimated:number; followerMessages:number;
        viewers: number | null;
        viewersPartial?: boolean;
        twitchViewers: number | null;
        youtubeViewers: number | null;
        presenceKnown: boolean;
        isBreak?: boolean;
    }>();
    const minute = (at: number) => { at = Math.floor(at / 60000) * 60000; let row = timeline.get(at); if (!row) {
        row = { at, messages: 0, twitchMessages:0,youtubeMessages:0,regularTwitchMessages:0,regularYoutubeMessages:0,followerTwitchMessages:0,followerYoutubeMessages:0,unknownMessages:0,unknownTwitchMessages:0,unknownYoutubeMessages:0, observed: 0, estimated: 0, regularObserved: 0, regularEstimated: 0, regularMessages: 0, viewers: null, twitchViewers: null, youtubeViewers: null, presenceKnown: false,participants:0,regularParticipants:0,followerParticipants:0,followerObserved:0,followerEstimated:0,followerMessages:0 };
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
        const messages = db.prepare(`SELECT i.person_id,es.session_id,min(e.occurred_at_ms) AS at,count(*) AS n,(SELECT c.category_id FROM stream_samples c WHERE c.session_id=es.session_id AND c.observed_at_ms<=e.occurred_at_ms ORDER BY c.observed_at_ms DESC LIMIT 1) AS cat FROM event_sessions es INDEXED BY event_sessions_session CROSS JOIN events e ON e.id=es.event_id JOIN identities i ON i.id=e.identity_id WHERE e.type='chat.message' AND e.occurred_at_ms>=? AND e.occurred_at_ms<? AND (json_extract(e.payload_json,'$.originChannelId') IS NULL OR json_extract(e.payload_json,'$.originChannelId')=e.account_id) AND es.session_id IN(SELECT value FROM json_each(?)) GROUP BY i.person_id,es.session_id,cast(e.occurred_at_ms/60000 AS INTEGER),cat LIMIT 50001`).all(from, to, sessionIds) as any[];
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
            minute(row.at).twitchMessages += row.n;
            addMessages(row.session_id, row.at, row.n, row.person_id, 'twitch');
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
            const segment=segmentAt(tip.session_id,tip.at)!;
            addDonation(categoryDonations,categoryDonationCounts,segment.categoryId,tip.currency,tip.amount);
            addDonation(streamDonations,streamDonationCounts,tip.session_id,tip.currency,tip.amount);
            const atMinute=Math.floor(tip.at/60000)*60000,totals=minuteDonations.get(atMinute)??{};
            totals[tip.currency]=(BigInt(totals[tip.currency]??'0')+BigInt(tip.amount)).toString();minuteDonations.set(atMinute,totals);minuteDonationCounts.set(atMinute,(minuteDonationCounts.get(atMinute)??0)+1);

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
                minute(chat.message_at).youtubeMessages += chat.n;
                addMessages(chat.sid, chat.message_at, chat.n, e.id, 'youtube');
            }
            e.intervals.push(...spans);
        }
    }
    let expanded = 0;
    const activityDurations = new Map<number, { observed: number; estimated: number }>();
    const elapsedMinutes=new Map<number,number>();
    // Materialize the selected recording interval, including empty samples and gaps.
    for (const segment of selected) for (let at = Math.floor(segment.from / 60000) * 60000; at < segment.to; at += 60000) {
        if (++expanded > 2000000) throw new Error('ANALYTICS_RANGE_TOO_LARGE');
        minute(at);
        elapsedMinutes.set(at,(elapsedMinutes.get(at)??0)+Math.max(0,Math.min(at+60000,segment.to)-Math.max(at,segment.from))/60000);
    }
    const followRows=db.prepare("SELECT p.source,p.account_id,p.payload_json FROM follower_observations p WHERE key='followers' AND id=(SELECT q.id FROM follower_observations q WHERE q.source=p.source AND q.account_id=p.account_id AND q.key='followers' ORDER BY observed_at_ms DESC,id DESC LIMIT 1)").all() as {source:string;account_id:string;payload_json:string}[];
    const followerPeople=new Set<string>(),negativeFollowers=new Set<string>();
    const platformFollowers={twitch:new Set<string>(),youtube:new Set<string>()};
    const platformNonFollowers={twitch:new Set<string>(),youtube:new Set<string>()};
    for(const snapshot of followRows){
      const data=JSON.parse(snapshot.payload_json);const ids=JSON.stringify((data.followers??[]).map((f:any)=>f.id));
      const members=snapshot.source==='youtube'?db.prepare('SELECT person_id FROM youtube_identities WHERE account_id=? AND external_id IN(SELECT value FROM json_each(?))').all(snapshot.account_id,ids):db.prepare("SELECT person_id FROM identities WHERE source='twitch' AND account_id=? AND external_id IN(SELECT value FROM json_each(?))").all(snapshot.account_id,ids);
      for(const member of members as {person_id:string}[]){followerPeople.add(member.person_id);if(snapshot.source==='twitch'||snapshot.source==='youtube')platformFollowers[snapshot.source].add(member.person_id);}
      if(snapshot.source==='twitch'&&data.complete){
        const absent=db.prepare("SELECT person_id FROM identities WHERE source='twitch' AND account_id=? AND external_id NOT IN(SELECT value FROM json_each(?))").all(snapshot.account_id,ids) as {person_id:string}[];
        for(const member of absent){negativeFollowers.add(member.person_id);platformNonFollowers.twitch.add(member.person_id);}
      }
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
        const arrivals=new Map<string,{day:string;hour:number;visits:number}>();
        for(const span of unionSpans(e.intervals.map(span=>({...span,kind:'observed' as const})))){
          const parts=clock.formatToParts(span.from),day=parts.find(x=>x.type==='weekday')!.value,hour=Number(parts.find(x=>x.type==='hour')!.value),key=`${day}:${hour}`;
          const arrival=arrivals.get(key)??{day,hour,visits:0};arrival.visits++;arrivals.set(key,arrival);
        }
        e.arrivalHours=[...arrivals.values()].sort((a,b)=>b.visits-a.visits||a.hour-b.hour);
        const long=activityMinutes>=minMinutes,chatty=e.messages>=minMessages;
        const automatic=e.attendanceSessionIds.size>=minSessions && e.attendanceSessionIds.size>0 && e.attendanceSessionIds.size/selectedStreamCount*100+1e-10>=regularThresholdPercent && (rule==='frequency'||(rule==='both'?long&&chatty:long||chatty));
        const override=preferences.get(e.id);
        e.manualCore=override==null?null:override===1;
        e.core=e.manualCore??automatic;
        e.follower=followerPeople.has(e.id)?true:negativeFollowers.has(e.id)&&!e.sources.includes('youtube')?false:null;
        e.regular=e.core; // Compatibility fields refer to the same audience core.
        const signalMinutes=new Set<string>();
        for (const span of e.intervals) {
            for (let at = Math.floor(span.from / 60000) * 60000; at < span.to; at += 60000) {
                if (++expanded > 2000000)
                    throw new Error('ANALYTICS_RANGE_TOO_LARGE');
                const duration = (Math.min(at + 60000, span.to) - Math.max(at, span.from)) / 60000;
                const durations = activityDurations.get(at) ?? { observed: 0, estimated: 0 };
                if (span.kind === 'observed') durations.observed += duration;
                else durations.estimated += duration;
                activityDurations.set(at, durations);
                const signalKey=`${span.kind}:${at}`;
                if(signalMinutes.has(signalKey))continue;
                signalMinutes.add(signalKey);
                const point = minute(at);
                if(!signalMinutes.has(`all:${at}`)){signalMinutes.add(`all:${at}`);point.participants++;if(e.core)point.regularParticipants++;else if(e.follower)point.followerParticipants++;}
                if (span.kind === 'observed'){point.observed++;if(e.regular)point.regularObserved++;else if(e.follower)point.followerObserved++;}
                else {point.estimated++;if(e.regular)point.regularEstimated++;else if(e.follower)point.followerEstimated++;}
            }
        }
    }
    for(const platform of ['twitch','youtube'] as const)for(const [at,authors] of platformMessageAuthors[platform])for(const [id,n] of authors){
        const point=minute(at),core=entities.get(id)?.core;
        if(core){point.regularMessages+=n;if(platform==='twitch')point.regularTwitchMessages+=n;else point.regularYoutubeMessages+=n;}
        else if(platformFollowers[platform].has(id)){point.followerMessages+=n;if(platform==='twitch')point.followerTwitchMessages+=n;else point.followerYoutubeMessages+=n;}
        else if(!platformNonFollowers[platform].has(id)){point.unknownMessages+=n;if(platform==='twitch')point.unknownTwitchMessages+=n;else point.unknownYoutubeMessages+=n;}
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
            if(source!=='youtube'&&sample.twitch_viewers !== null)point.twitchViewers=sample.twitch_viewers;
            if(source!=='twitch'&&sample.youtube_viewers !== null)point.youtubeViewers=sample.youtube_viewers;
            const active=(platformsBySession.get(sample.session_id)??[]).filter(p=>p.started_at_ms<point.at+60000&&(p.ended_at_ms===null||p.ended_at_ms>point.at));
            const keys=active.length?[...new Set(active.map(p=>p.platform==='twitch'?'twitchViewers':'youtubeViewers'))]:['twitchViewers'];
            const known=[point.twitchViewers,point.youtubeViewers].filter((value):value is number=>value!==null);
            point.viewers = source === 'twitch' ? point.twitchViewers : source === 'youtube' ? point.youtubeViewers : known.length?known.reduce((sum,value)=>sum+value,0):null;
            point.viewersPartial = source === 'all' && known.length>0 && keys.some(key=>point[key as 'twitchViewers'|'youtubeViewers']===null);
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
    for(const span of breaks)for(let at=Math.ceil(Math.max(from,span.from)/60000)*60000;at+60000<=Math.min(to,span.to);at+=60000){
        if(++expanded>2000000)throw new Error('ANALYTICS_RANGE_TOO_LARGE');
        minute(at).isBreak=true;
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
        donationTotals:Record<string,string>;donationCount:number;
    }>();
    for (const point of timeline.values()) {
        const parts = clock.formatToParts(point.at), day = parts.find(x => x.type === 'weekday')!.value, hour = Number(parts.find(x => x.type === 'hour')!.value), key = `${day}:${hour}`;
        let cell = hourly.get(key);
        if (!cell) {
            cell = { day, hour, observed: 0, estimated: 0, messages: 0, sampleMinutes: 0, observedKnownMinutes: 0, viewersTotal: 0, viewerSamples: 0,donationTotals:{},donationCount:0 };
            hourly.set(key, cell);
        }
        const elapsed=elapsedMinutes.get(point.at)??0;
        cell.observed += activityDurations.get(point.at)?.observed ?? 0;
        cell.estimated += activityDurations.get(point.at)?.estimated ?? 0;
        for(const [currency,total] of Object.entries(minuteDonations.get(point.at)??{}))cell.donationTotals[currency]=(BigInt(cell.donationTotals[currency]??'0')+BigInt(total)).toString();
        cell.donationCount+=minuteDonationCounts.get(point.at)??0;
        cell.messages += point.messages;
        cell.sampleMinutes+=elapsed;
        if(point.viewers !== null&&!point.viewersPartial) {cell.viewersTotal+=point.viewers*elapsed;cell.viewerSamples+=elapsed;}
        if (point.presenceKnown)
            cell.observedKnownMinutes+=elapsed;
    }
    const accountsByPerson=new Map<string,{source:string;name:string}[]>();
    for(const row of db.prepare("SELECT person_id,source,display_name FROM identities WHERE source='twitch' AND person_id IN(SELECT value FROM json_each(?)) UNION ALL SELECT person_id,'youtube' AS source,display_name FROM youtube_identities WHERE person_id IN(SELECT value FROM json_each(?))").all(JSON.stringify([...entities.keys()]),JSON.stringify([...entities.keys()])) as {person_id:string;source:string;display_name:string}[]){
        const accounts=accountsByPerson.get(row.person_id)??[];accounts.push({source:row.source,name:row.display_name});accountsByPerson.set(row.person_id,accounts);
    }
    const messageMinutesByPerson=new Map<string,{session:string;at:number}[]>();
    for(const [session,minutes] of streamAuthors)for(const [at,ids] of minutes)for(const id of ids){const rows=messageMinutesByPerson.get(id)??[];rows.push({session,at});messageMinutesByPerson.set(id,rows);}
    const messageCounts=new Map<string,{at:number;source:string;count:number}[]>();
    for(const source of ['twitch','youtube'] as const)for(const [at,authors] of platformMessageAuthors[source])for(const [id,count]of authors){const rows=messageCounts.get(id)??[];rows.push({at,source,count});messageCounts.set(id,rows);}
    const audience = [...entities.values()].filter(e => e.sessionIds.size || e.messages).sort((a, b) => Number(b.core) - Number(a.core) || b.observedMinutes - a.observedMinutes || b.messages - a.messages).map(e => ({ ...e,messageCounts:messageCounts.get(e.id)??[],messageMinutes:messageMinutesByPerson.get(e.id)??[], accounts:(accountsByPerson.get(e.id)??[]).filter(account=>e.sources.includes(account.source as 'twitch'|'youtube')), sessionIds: [...e.sessionIds], attendanceSessionIds: [...e.attendanceSessionIds], attendanceRatio: selectedStreamCount?e.attendanceSessionIds.size/selectedStreamCount:0, visits: e.intervals.length, observedMinutesPerSession: e.attendanceSessionIds.size ? e.observedMinutes/e.attendanceSessionIds.size : 0, sessionRatio: e.sessionIds.size/selectedStreamCount, observedMinutes: Math.round(e.observedMinutes * 10) / 10, estimatedChatMinutes: Math.round(e.estimatedChatMinutes * 10) / 10 }));
    const attendees=audience.filter(e=>e.attendanceSessionIds.length>0),regulars=audience.filter(e=>e.core).length;
    const patterns=timePatterns([...hourly.values()]);
    const composition={core:attendees.filter(e=>e.core).length,followers:attendees.filter(e=>!e.core&&e.follower===true).length,nonFollowers:attendees.filter(e=>!e.core&&e.follower===false).length,unknown:attendees.filter(e=>!e.core&&e.follower===null).length,twitch:attendees.filter(e=>e.sources.includes('twitch')).length,youtube:attendees.filter(e=>e.sources.includes('youtube')).length,both:attendees.filter(e=>e.sources.length>1).length};
    const seen = new Set<string>();
    const streamComparison = sessions.filter(s => selectedBySession.has(s.id)).map(s => {
        const visitors = audience.filter(e => e.attendanceSessionIds.includes(s.id)), newInPeriod = visitors.filter(e => !seen.has(e.id)).length;
        for (const e of visitors)
            seen.add(e.id);
        const durationMs=(selectedBySession.get(s.id)??[]).reduce((n,segment)=>n+segment.to-segment.from,0);
        const donations=streamDonations.get(s.id)??{},messages=sessionMessages.get(s.id)??0;
        const metrics=streamMetrics((selectedBySession.get(s.id)??[]),(samplesBySession.get(s.id)??[]),streamAuthors.get(s.id)??new Map());
        const aggregate=streamMetrics((selectedBySession.get(s.id)??[]),[...new Set((selectedBySession.get(s.id)??[]).flatMap(segment=>Array.from({length:Math.ceil(segment.to/60000)-Math.floor(segment.from/60000)},(_,i)=>(Math.floor(segment.from/60000)+i)*60000)))].map(at=>timeline.get(at)!).filter(Boolean).map(p=>({observed_at_ms:p.at,twitch_viewers:p.viewersPartial?null:p.viewers,youtube_viewers:0})),new Map());
        metrics.viewers.all=aggregate.viewers.all;
        let participantMs=0,peakParticipants=0;
        const participantsByMinute=new Map<number,Set<string>>();
        for(const visitor of visitors)for(const span of unionSpans(visitor.intervals.filter(span=>span.session===s.id).map(span=>({...span,kind:'observed' as const})))){
            participantMs+=span.to-span.from;
            for(let at=Math.floor(span.from/60000)*60000;at<span.to;at+=60000){const ids=participantsByMinute.get(at)??new Set<string>();ids.add(visitor.id);participantsByMinute.set(at,ids);peakParticipants=Math.max(peakParticipants,ids.size);}
        }
        return { ...metrics,meanParticipants:durationMs?participantMs/durationMs:null,peakParticipants,durationMs,messagesPerHour:durationMs?messages*3600000/durationMs:null,donationCount:streamDonationCounts.get(s.id)??0,donationTotals:donations,donationsPerHourMinor:currencyRates(donations,durationMs),id: s.id, startedAt: s.started_at_ms, endedAt: s.ended_at_ms ?? to, title: samplesBySession.get(s.id)?.[0]?.title ?? "", audience: visitors.length, core: visitors.filter(e => e.core).length, newInPeriod, returning: visitors.length - newInPeriod, messages: sessionMessages.get(s.id) ?? 0, categories: [...new Set((selectedBySession.get(s.id)??[]).filter(segment=>segment.categoryId&&segment.name!=='Категория неизвестна').map(segment => segment.name))] };
    });
    const report=source!=='twitch'&&options.youtubeAccount ? db.prepare("SELECT payload_json,updated_at_ms FROM youtube_snapshots WHERE account_id=? AND key='report'").get(options.youtubeAccount) as {payload_json:string;updated_at_ms:number}|undefined : undefined;
    const youtubeReport=report ? {data:JSON.parse(report.payload_json),updatedAt:report.updated_at_ms} : null;
    return { activityClock:clockActivity([...timeline.values()],selected,timezone), donationTiming:donationTiming(db,from,to,timezone,category),activityWindows:selected, patterns,composition,breaks, youtubeReport, streamComparison, availableCategories: [...new Map(segments.filter(s=>s.categoryId&&s.name!=='Категория неизвестна').map(s => [s.categoryId, { id: s.categoryId, name: s.name }])).values()], filters: { fromMs: from, toMs: to, source, category, minSessions, minMinutes, minMessages, regularThresholdPercent, coreRule: rule, chatWindowMinutes: window, timezone }, summary: { entities: audience.length, attendees: attendees.length, regulars, regularShare: audience.length?regulars/audience.length:null, core: audience.filter(e => e.core).length, streams: new Set(selected.map(x => x.session)).size, chatters:audience.filter(e=>e.messages>0).length, messages: audience.reduce((sum, e) => sum + e.messages, 0) }, audience, categories: [...categories.values()].filter(c=>c.id&&c.name!=='Категория неизвестна').map(c => ({ ...c, donationCount:categoryDonationCounts.get(c.id)??0,donationTotals:categoryDonations.get(c.id)??{},donationsPerHourMinor:currencyRates(categoryDonations.get(c.id)??{},Math.round(c.minutes*60000)),sessions: c.sessions.size, audience: c.audience.size, core: c.core.size, messagesPerHour: c.minutes ? c.messages * 60 / c.minutes : 0, observedPerMinute: c.minutes ? c.observedMinutes / c.minutes : 0, observedPerKnownMinute: c.observedKnownMinutes ? c.observedMinutes / c.observedKnownMinutes : null, coverageRatio: c.minutes ? c.observedKnownMinutes/c.minutes : null })), timeline: [...timeline.values()].sort((a, b) => a.at - b.at), hours: [...hourly.values()].map(cell=>({...cell,donationsPerHourMinor:currencyRates(cell.donationTotals,Math.round(cell.sampleMinutes*60000))})).sort((a, b) => ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].indexOf(a.day) - ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].indexOf(b.day) || a.hour - b.hour), sessions, excluded: [...excluded] };
}
