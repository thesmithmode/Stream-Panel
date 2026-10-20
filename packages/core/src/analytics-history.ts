import {latestFollowerChecksSql,latestFollowerSnapshotsSql} from './follower-queries.js';
import {dateTimeFormatter} from './date-time-formatter.js';
import {streamInsights,InsightAccumulator,type InsightCard} from './insights.js';
import {mergeClockActivity, type ClockActivity} from './clock-activity.js';
import {AnalyticsWorkspace} from './analytics-workspace.js';
import {AnalyticsReportCache} from './analytics-report-cache.js';
import { HistoryTimeline } from "./history-timeline.js";
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import {serialize} from 'node:v8';
import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { audienceAnalytics, validateAnalyticsOptions, unionSpans, type AnalyticsOptions } from './analytics.js';
import { timeAudience, matchesActivityDay, type TimeAudienceSummary } from './time-audience.js';
import { timePatterns } from './time-patterns.js';
import { currencyRates } from './rates.js';
import { donationTiming } from './donation-statistics.js';
const days = ['all', 'weekdays', 'weekends', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const resolutions = [1, 5, 15, 30, 60];
type Session = {
    id: string;
    started_at_ms: number;
    ended_at_ms: number | null;
    revision: number;
};
type Report = ReturnType<typeof audienceAnalytics> & {
    insights?:InsightCard[];
    clockBuckets?: ClockBucket[];
    clockRevision?:string;
    aggregate?: boolean;
    preparing?: boolean;
    ready?: number;
    total?: number;
    stage?: string;
    audiencePage?: {total:number;offset:number;limit:number};
    clockVisitors?: ReturnType<AnalyticsWorkspace<Person>['clockPage']>;
};
type ClockResponse={filters:Report['filters'];clockVisitors?:ReturnType<AnalyticsWorkspace<Person>['clockPage']>;clockPages?:ReturnType<AnalyticsWorkspace<Person>['clockPages']>;preparing?:boolean;ready?:number;total?:number;stage?:string};
type Person = Report['audience'][number] & {
    sessionCount: number;
    attendanceCount: number;
    activityMinutes: number;
    detailAvailable?: boolean;
};
type Stream = Report['streamComparison'][number];
type Category = Report['categories'][number];
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
    private readonly reportCache:AnalyticsReportCache<Report>;
    private statements = new Map<string, Database.Statement>();
    private statement(sql: string) {
        let statement = this.statements.get(sql);
        if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
        return statement;
    }
    private readonly completed = new Map<string,{value:Report;bytes:number;workspace?:AnalyticsWorkspace<Person>;liveRevision?:string}>();
    private completedBytes=0;
    private remember(key:string,value:Report,workspace?:AnalyticsWorkspace<Person>,liveRevision?:string){
        const limit=this.cachePolicy.maxCompletedBytes??16*1024*1024,bytes=serialize(value).byteLength;
        if(bytes>limit){workspace?.dispose();return;}
        const previous=this.completed.get(key);if(previous){previous.workspace?.dispose();this.completedBytes-=previous.bytes;this.completed.delete(key);}
        while(this.completed.size>=16||this.completedBytes+bytes>limit){const oldest=this.completed.keys().next().value!;this.completedBytes-=this.completed.get(oldest)!.bytes;this.completed.get(oldest)!.workspace?.dispose();this.completed.delete(oldest);}
        this.completed.set(key,{value:structuredClone(value),bytes,...(workspace?{workspace}:{}),...(liveRevision?{liveRevision}:{})});this.completedBytes+=bytes;
    }
    private readonly jobs = new Map<string, {
        iterator: Generator<Progress, Report, void>;
        touchedAt: number;
        workspace:AnalyticsWorkspace<Person>;
        liveRevision:string;
        validation:Report;
    }>();
    private pruneJobs(now=Date.now()) {
        for (const [key, job] of this.jobs)
            if (now-job.touchedAt>300000) {job.workspace.dispose();this.jobs.delete(key);}
    }
    constructor(private readonly db: Database.Database, private readonly cachePolicy: {
        availableBytes?: () => number;
        maxBytes?: number;
        maxTotalBytes?: number;
        maxCompletedBytes?: number;
        maxReportBytes?: number;
    } = {}) {
        this.reportCache=new AnalyticsReportCache(db,cachePolicy.maxReportBytes);
        if(db.pragma('temp_store',{simple:true})!==1)db.pragma('temp_store=FILE');
        db.pragma('temp.cache_size=-2048');
    }
    close(){this.liveStreams.clear();for(const job of this.jobs.values())job.workspace.dispose();this.jobs.clear();for(const entry of this.completed.values())entry.workspace?.dispose();this.completed.clear();this.completedBytes=0;}
    private page(value:Report,workspace:AnalyticsWorkspace<Person>|undefined,options:AnalyticsOptions):Report{
        if(!workspace)return value;
        const page=workspace.people.page(options.audienceOffset??0,options.audienceSearch??'',options.audienceSort??'core',options.audienceCoreOnly??false);
        return {...value,audience:page.items,...(workspace.people.size>100?{audiencePage:{total:page.total,offset:page.offset,limit:page.limit}}:{}),...(options.clockMinute!==undefined?{clockVisitors:workspace.clockPage(options.clockDay??'all',options.clockMinute,options.clockResolution??60,options.clockOffset??0)}:{})};
    }
    private clockResult(value:Report,workspace:AnalyticsWorkspace<Person>|undefined,options:AnalyticsOptions):ClockResponse{
        const day=options.clockDay??'all',minute=options.clockMinute??0,resolution=options.clockResolution??60;
        return {filters:value.filters,...(options.clockBatch?{clockPages:workspace?.clockPages(day,minute,resolution)??[]}:{clockVisitors:workspace?.clockPage(day,minute,resolution,options.clockOffset??0)??{items:[],total:0,offset:options.clockOffset??0,limit:100}})};
    }
    clockAudience(options:AnalyticsOptions):ClockResponse{return this.resolve(options,true,true);}
    private checkWorkspace(workspace:AnalyticsWorkspace<Person>){
        for(;;){
            try{workspace.checkBudget();return;}catch(error){
                if(!(error instanceof Error)||error.message!=='ANALYTICS_WORKSPACE_LIMIT')throw error;
                const retained=[...this.completed].find(([,entry])=>entry.workspace);
                if(retained){const [key,entry]=retained;entry.workspace!.dispose();this.completedBytes-=entry.bytes;this.completed.delete(key);continue;}
                const pending=[...this.jobs].find(([,job])=>job.workspace!==workspace);
                if(pending){pending[1].workspace.dispose();this.jobs.delete(pending[0]);continue;}
                throw error;
            }
        }
    }
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
        const fields = { format: 8, from: Math.max(options.fromMs, session.started_at_ms), to: Math.min(options.toMs, session.ended_at_ms ?? options.toMs), source: options.source ?? 'all', category: options.category ?? '', timezone: options.timezone ?? 'Europe/Moscow', chatWindowMinutes: options.chatWindowMinutes ?? 5, excluded: [...(options.excludedLogins ?? [])].sort(), owner: options.ownerId ?? '', youtube: options.youtubeAccount ?? '' };
        return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
    }
    private globalRevision() { return (this.statement('SELECT revision FROM analytics_global_revision WHERE id=1').get() as {
        revision: number;
    }).revision; }
    private followerRevision(){
        // A repeated check of the same payload must not rebuild unchanged history.
        // Seek the latest check for each distinct payload instead of scanning all checks.
        return this.statement(`SELECT source,account_id,snapshot_id AS id FROM (${latestFollowerChecksSql}) ORDER BY source,account_id`).all();
    }
    private build(options: AnalyticsOptions, session: Session): Report {
        const report = audienceAnalytics(this.db, { ...options, sessionId: session.id });
        // Each cached report represents one logical stream; attendance is deduplicated
        // within that report before counts from different streams are added.
        const clockBuckets: ClockBucket[] = [];
        const clock = dateTimeFormatter('ru-RU', { timeZone: options.timezone ?? 'Europe/Moscow', weekday: 'short' }), presentDays = new Set<string>();
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
        return { ...report, clockBuckets, insights:streamInsights(report,options.timezone) };
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
        let ready=0;
        for(const session of [...sessions].reverse()){
            if(session.ended_at_ms===null){ready++;continue;}
            // Bake only recorded categories, with a fixed variant bound per stream.
            const categories=options.category?[options.category]:['',...(this.statement("SELECT DISTINCT category_id FROM stream_samples WHERE session_id=? AND category_id<>'' AND category_name<>'' ORDER BY category_id LIMIT 7").all(session.id) as {category_id:string}[]).map(c=>c.category_id)];
            let complete=true;
            for(const category of categories){
                const variant={...options,category};
                if(this.statement('SELECT 1 FROM analytics_stream_cache WHERE session_id=? AND cache_key=? AND revision=? AND global_revision=?').get(session.id,this.key(variant,session),session.revision,global))continue;
                if(performance.now()-start>=250){complete=false;break;}
                if(!this.save(variant,session,global,this.build(variant,session),false))return {preparing:false,ready,total:sessions.length};
            }
            if(complete)ready++;
        }
        return {preparing:ready<sessions.length,ready,total:sessions.length};
    }
    private liveStreams=new Map<string,{revision:string;report:Report}>();
    streamReport(options:AnalyticsOptions):Report {
        const session=this.sessions(options).find(s=>s.id===options.sessionId);
        if(!session)return audienceAnalytics(this.db,options);
        const global=this.globalRevision(),key=this.key(options,session),revision=`${global}:${session.revision}`,live=this.liveStreams.get(key),cached=session.ended_at_ms===null&&live?.revision===revision?live.report:this.cached(options,session,global);
        if(cached)return cached;
        const report=this.build(options,session);this.save(options,session,global,report);
        if(session.ended_at_ms===null){while(this.liveStreams.size>=12)this.liveStreams.delete(this.liveStreams.keys().next().value!);this.liveStreams.set(key,{revision,report});}return report;
    }
    private warmedRevision='';
    private warming:{revision:string;categories:string[];index:number}|undefined;
    private background=false;
    private warmReport(options:AnalyticsOptions){this.background=true;try{return this.report(options);}finally{this.background=false;}}
    warm(options:AnalyticsOptions,bakeCategories=false){
        // Bake the landing report, not a Cartesian product of moving windows.
        // Live facts already have collector priority; finalize after the stream ends.
        const current:AnalyticsOptions={...options,source:'all',category:'',fromMs:0,summaryOnly:true,includeInsights:true};
        const sessions=this.sessions(current);
        if(sessions.some(s=>s.ended_at_ms===null)){this.warming=undefined;return {preparing:false,ready:0,total:0};}
        const {fromMs,toMs,...settings}=current;void fromMs;void toMs;
        const revision=JSON.stringify([settings,bakeCategories,this.globalRevision(),sessions,this.annotationsRevision(),this.followerRevision()]);
        if(revision===this.warmedRevision)return {preparing:false,ready:1,total:1};
        if(this.warming?.revision!==revision){
            const categories=bakeCategories?this.statement("SELECT category_id AS id FROM stream_samples WHERE category_id<>'' AND category_name<>'' GROUP BY category_id ORDER BY count(*) DESC,category_id LIMIT 6").all() as {id:string}[]:[];
            this.warming={revision,categories:['',...categories.map(c=>c.id)],index:0};
        }
        const job=this.warming,report=this.warmReport({...current,category:job.categories[job.index]!});
        if(report.preparing)return {preparing:true,ready:report.ready??0,total:report.total??1};
        // Advance only the unfinished report; do not reread/clone all completed
        // categories on every background slice. Yield between ready reports too.
        job.index++;
        if(job.index<job.categories.length)return {preparing:true,ready:job.index,total:job.categories.length};
        this.warmedRevision=revision;
        this.warming=undefined;
        return {preparing:false,ready:1,total:1};
    }
    private annotationsRevision(){return [this.statement('SELECT * FROM person_preferences ORDER BY person_id').all(),this.statement('SELECT * FROM person_tags ORDER BY person_id,label').all(),this.statement("SELECT id,source,started_at_ms,ended_at_ms FROM collection_gaps WHERE source IN('twitch','youtube') ORDER BY id").all()];}
    query(options:AnalyticsOptions):Report{
        return options.sessionId?this.sessionReport(options):this.resolve(options,options.summaryOnly??false);
    }
    private sessionReport(options:AnalyticsOptions):Report{
        const session=this.statement(`SELECT s.id,s.started_at_ms,s.ended_at_ms,coalesce(r.revision,0) AS revision FROM sessions s LEFT JOIN analytics_stream_revisions r ON r.session_id=s.id WHERE s.id=? AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=s.id)`).get(options.sessionId) as Session|undefined;
        if(!session||session.ended_at_ms===null)return audienceAnalytics(this.db,options);
        const canonical={...options,fromMs:Math.max(options.fromMs,session.started_at_ms),toMs:Math.min(options.toMs,session.ended_at_ms)};
        validateAnalyticsOptions(canonical);
        const snapshot=options.source!=='twitch'&&options.youtubeAccount?this.statement("SELECT payload_json,updated_at_ms FROM youtube_snapshots WHERE account_id=? AND key='report'").get(options.youtubeAccount):null;
        const scope='session:'+createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(canonical).sort(([a],[b])=>a.localeCompare(b))))).digest('hex');
        const key=createHash('sha256').update(JSON.stringify([scope,session.revision,this.globalRevision(),this.annotationsRevision(),this.followerRevision(),snapshot])).digest('hex');
        const retained=this.completed.get(key);
        if(retained){this.completed.delete(key);this.completed.set(key,retained);return structuredClone(retained.value);}
        const saved=this.reportCache.get(key);
        const value=saved??audienceAnalytics(this.db,canonical);
        if(!saved&&(this.cachePolicy.availableBytes?.()??Infinity)>=1024*1024*1024)this.reportCache.save(key,scope,value);
        this.remember(key,value);
        return value;
    }
    report(options:AnalyticsOptions):Report{return this.resolve(options,true);}
    private resolve(options:AnalyticsOptions,historical:boolean,clockOnly?:false):Report;
    private resolve(options:AnalyticsOptions,historical:boolean,clockOnly:true):ClockResponse;
    private resolve(options: AnalyticsOptions,historical:boolean,clockOnly=false):Report|ClockResponse {
        this.checkCacheBudget();
        // Validate filters without loading audience facts on a completed-cache hit.
        if (!Number.isSafeInteger(options.fromMs) || options.fromMs < 0 || !Number.isSafeInteger(options.toMs) || options.toMs <= options.fromMs)
            throw new Error('INVALID_ANALYTICS_FILTER');
        validateAnalyticsOptions(options);
        const sessions = this.sessions(options);
        const live = sessions.some(session => session.ended_at_ms === null);
        const lastEnd = sessions.reduce((end, session) => Math.max(end, session.ended_at_ms ?? options.toMs), options.fromMs);
        const {audienceOffset,audienceSearch,audienceSort,audienceCoreOnly,clockDay,clockMinute,clockResolution,clockOffset,clockBatch,...baseOptions}=options;
        void audienceOffset;void audienceSearch;void audienceSort;void audienceCoreOnly;void clockDay;void clockMinute;void clockResolution;void clockOffset;void clockBatch;
        const canonical = { ...baseOptions,source:options.source??'all',category:options.category??'', fromMs: Math.max(options.fromMs, sessions[0]?.started_at_ms ?? options.fromMs), toMs: live ? options.toMs : Math.min(options.toMs, lastEnd) };
        const fingerprint = createHash('sha256').update(JSON.stringify([3,historical, Object.fromEntries(Object.entries(canonical).sort(([a],[b])=>a.localeCompare(b))), this.globalRevision(), sessions.map(s => [s.id, s.ended_at_ms === null ? 0 : s.revision]), this.annotationsRevision(), this.followerRevision()])).digest('hex');
        const liveRevision=JSON.stringify(sessions.filter(s=>s.ended_at_ms===null).map(s=>[s.id,s.revision]));
        const retained=this.completed.get(fingerprint);
        const cached=retained&&(!live||retained.liveRevision===liveRevision)?retained:undefined;
        if(cached){
            if(clockOnly)return this.clockResult({...cached.value,filters:{...cached.value.filters,fromMs:options.fromMs,toMs:options.toMs}},cached.workspace,options);
            this.completed.delete(fingerprint);this.completed.set(fingerprint,cached);
            const youtube = options.source !== 'twitch' && options.youtubeAccount ? this.statement("SELECT payload_json,updated_at_ms FROM youtube_snapshots WHERE account_id=? AND key='report'").get(options.youtubeAccount) as { payload_json: string; updated_at_ms: number } | undefined : undefined;
            return this.page({ ...structuredClone(cached.value), filters: { ...cached.value.filters, fromMs: options.fromMs, toMs: options.toMs }, youtubeReport: youtube ? { data: JSON.parse(youtube.payload_json), updatedAt: youtube.updated_at_ms } : null, donationTiming: donationTiming(this.db, options.fromMs, options.toMs, options.timezone ?? 'Europe/Moscow', options.category) },cached.workspace,options);
        }
        const saved=!live&&historical?this.reportCache.get(fingerprint):undefined;
        if(saved){
            const workspace=new AnalyticsWorkspace<Person>(this.db,fingerprint);
            try{
                const value={...saved,filters:{...saved.filters,fromMs:options.fromMs,toMs:options.toMs}};
                if(clockOnly)return this.clockResult(value,workspace,options);
                const youtube=options.source!=='twitch'&&options.youtubeAccount?this.statement("SELECT payload_json,updated_at_ms FROM youtube_snapshots WHERE account_id=? AND key='report'").get(options.youtubeAccount) as {payload_json:string;updated_at_ms:number}|undefined:undefined;
                return this.page({...value,youtubeReport:youtube?{data:JSON.parse(youtube.payload_json),updatedAt:youtube.updated_at_ms}:null,donationTiming:donationTiming(this.db,options.fromMs,options.toMs,options.timezone??'Europe/Moscow',options.category)},workspace,options);
            }finally{workspace.dispose();}
        }
        if(!historical&&sessions.length<=200){
            try{
                const value=audienceAnalytics(this.db,options);
                if(!live)this.remember(fingerprint,value);
                return value;
            }catch(error){if(!(error instanceof Error)||error.message!=='ANALYTICS_RANGE_TOO_LARGE')throw error;}
        }
        const now = Date.now();
        this.pruneJobs(now);
        let job = this.jobs.get(fingerprint);
        if (!job) {
            // Each browser/filter keeps its own progress, with a bounded LRU budget.
            while (this.jobs.size >= 4) {const key=this.jobs.keys().next().value!;this.jobs.get(key)!.workspace.dispose();this.jobs.delete(key);}
            const validation=audienceAnalytics(this.db,{...options,fromMs:options.toMs-1,toMs:options.toMs});
            const workspace=new AnalyticsWorkspace<Person>(this.db);
            job = { iterator: this.aggregate(options, sessions, validation,workspace), touchedAt: now,workspace,liveRevision,validation };
        }
        this.jobs.delete(fingerprint);
        this.jobs.set(fingerprint, job);
        job.touchedAt = now;
        const validation=job.validation;
        let next: IteratorResult<Progress, Report>;
        try {
            next = job.iterator.next();
        }
        catch (error) {
            this.jobs.delete(fingerprint);job.workspace.dispose();
            throw error;
        }
        if (!next.done)
            return clockOnly?{filters:validation.filters,...next.value,stage:'aggregate'}:{ ...validation, ...next.value, stage: 'aggregate' };
        this.jobs.delete(fingerprint);
        next.value.clockRevision=fingerprint;
        try{
            const value=clockOnly?this.clockResult(next.value,job.workspace,options):this.page(next.value,job.workspace,options);
            if(!live&&historical&&(this.cachePolicy.availableBytes?.()??Infinity)>=1024*1024*1024){
                const {fromMs,toMs,...scopeOptions}=canonical;
                const period=options.fromMs===0?'all':[7,30].find(days=>options.toMs-options.fromMs===days*86400000)??[fromMs,toMs];
                const scope=createHash('sha256').update(JSON.stringify([Object.fromEntries(Object.entries(scopeOptions).sort(([a],[b])=>a.localeCompare(b))),period])).digest('hex');
                this.reportCache.save(fingerprint,scope,next.value,job.workspace,!this.background);
            }
            this.remember(fingerprint,next.value,job.workspace,job.liveRevision);
            return value;
        }catch(error){job.workspace.dispose();throw error;}
    }
    private *aggregate(options: AnalyticsOptions, sessions: Session[], validation: ReturnType<typeof audienceAnalytics>,workspace:AnalyticsWorkspace<Person>): Generator<Progress, Report, void> {
        let sliceStart = performance.now();
        const active = new Map<string, Report>(), read = (session: Session) => {
            if (session.ended_at_ms === null) {
                let report = active.get(session.id);
                if (!report) {
                    report = this.streamReport({...options,sessionId:session.id});
                    active.set(session.id, report);
                }
                return report;
            }
            let report = this.cached(options, session, this.globalRevision());
            if (!report) {
                report = this.build(options, session);
                this.save(options, session, this.globalRevision(), report,!this.background);
            }
            return report;
        };
        let processed = 0;
        const people=workspace.people,streams:Stream[]=[],categoryRows=new Map<string,Category>(),hours=new Map<string,Hour>(),clockRows=new Map<string,ClockBucket>(),categories=new Map<string,{id:string;name:string}>();
        const activityClock = new Map<string,ClockActivity>();
        const insightBuilder=options.includeInsights?new InsightAccumulator(workspace.insightPeople,options.timezone,options.insightSessionId):undefined;
        let sample: Report | undefined;
        let selectedStreams = 0;
        for (const session of sessions) {
            const report = read(session);
            sample = report;
            if(insightBuilder){
                const start=report.activityWindows[0]?.from??session.started_at_ms,end=report.activityWindows.at(-1)?.to??start;
                const recording=this.statement('SELECT recording_started_at_ms AS start FROM sessions WHERE id=?').get(session.id) as {start:number};
                const gaps=this.statement("SELECT 1 FROM collection_gaps WHERE source IN('twitch','youtube') AND started_at_ms<? AND coalesce(ended_at_ms,?)>? LIMIT 1").get(end,end,start);
                const tips=this.statement("SELECT i.person_id AS personId,e.occurred_at_ms AS at FROM event_sessions es CROSS JOIN effective_events e ON e.id=es.event_id JOIN identities i ON i.id=e.identity_id WHERE es.session_id=? AND e.type='donation' AND e.occurred_at_ms>=? AND e.occurred_at_ms<?").all(session.id,start,end) as {personId:string;at:number}[];
                insightBuilder.add(report,recording.start<=start&&!gaps,tips);
            }
            mergeClockActivity(report.activityClock,activityClock);
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
                people.set(person.id,row);
            }
            for (const category of report.categories) {
                let row = categoryRows.get(category.id);
                if (!row) {
                    row = { ...category, minutes: 0, messages: 0, observedMinutes: 0, observedKnownMinutes: 0, estimatedChatMinutes: 0, sessions: 0, donationCount: 0, donationTotals: {} };
                    categoryRows.set(category.id, row);
                }
                for (const key of ['minutes', 'messages', 'observedMinutes', 'observedKnownMinutes', 'estimatedChatMinutes', 'sessions', 'donationCount'] as const)
                    row[key] += category[key];
                sumMoney(row.donationTotals, category.donationTotals);
                for (const person of report.audience)
                    if (person.intervals.some(span => report.activityWindows.some(w => w.categoryId === category.id && w.session === span.session && w.from < span.to && w.to > span.from)) || person.messageMinutes.some(m => report.activityWindows.some(w => w.categoryId === category.id && w.session === m.session && m.at >= w.from && m.at < w.to)))
                        workspace.categoryPerson(category.id,person.id);
            }
            for (const cell of report.hours) {
                const key = cell.day + ':' + cell.hour;
                let row = hours.get(key);
                if (!row) {
                    row = { ...cell, observed: 0, estimated: 0, messages: 0, sampleMinutes: 0, observedKnownMinutes: 0, viewersTotal: 0, viewerSamples: 0, knownViewersTotal:0,knownViewerSamples:0,viewerPartialMinutes:0, donationCount: 0, donationTotals: {} };
                    hours.set(key, row);
                }
                for(const field of ['knownViewersTotal','knownViewerSamples','viewerPartialMinutes'] as const)row[field]=(row[field]??0)+(cell[field]??0);
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

                }
                row.streams += bucket.streams;
                row.airtimeMs += bucket.airtimeMs;
                row.personTimeMs += bucket.personTimeMs;
            }
            workspace.addClock(session.id,report.clockBuckets??[]);
            this.checkWorkspace(workspace);
            processed++;
            if (performance.now() - sliceStart > 250) {
                yield { preparing: true, ready: processed, total: sessions.length * 2 };
                sliceStart = performance.now();
            }
        }
        if (!sample)
            return {...audienceAnalytics(this.db, options),...(options.includeInsights?{insights:[]}: {})};
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
            person.detailAvailable=true;people.set(person.id,person);
            if(performance.now()-sliceStart>250){yield {preparing:true,ready:processed,total:sessions.length*2};sliceStart=performance.now();}
        }
        const current = this.statement(latestFollowerSnapshotsSql).all() as {
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
        const summary={entities:people.size,attendees:0,regulars:0,regularShare:null as number|null,core:0,streams:selectedStreams,chatters:0,messages:0};
        const composition={core:0,followers:0,nonFollowers:0,unknown:0,twitch:0,youtube:0,both:0};
        for (const person of people.values()) {
            person.follower = followers.has(person.id) ? true : negative.has(person.id) && !person.sources.includes('youtube') ? false : null;
            person.tags = (this.statement(`WITH RECURSIVE owners(id) AS(SELECT ? UNION SELECT m.source_person_id FROM person_merges m JOIN owners o ON m.target_person_id=o.id WHERE m.undone_at_ms IS NULL) SELECT DISTINCT t.label FROM person_tags t JOIN owners o ON o.id=t.person_id ORDER BY t.label`).all(person.id) as {
                label: string;
            }[]).map(t => t.label);
            people.set(person.id,person);summary.core+=Number(person.core);summary.chatters+=Number(person.messages>0);summary.messages+=person.messages;
            if(person.attendanceSessionIds.length){summary.attendees++;composition.core+=Number(person.core);composition.followers+=Number(!person.core&&person.follower===true);composition.nonFollowers+=Number(!person.core&&person.follower===false);composition.unknown+=Number(!person.core&&person.follower===null);composition.twitch+=Number(person.sources.includes('twitch'));composition.youtube+=Number(person.sources.includes('youtube'));composition.both+=Number(person.sources.length>1);}
            if(performance.now()-sliceStart>250){yield {preparing:true,ready:processed,total:sessions.length*2};sliceStart=performance.now();}
        }
        summary.regulars=summary.core;summary.regularShare=summary.entities?summary.core/summary.entities:null;
        const daily = new HistoryTimeline(options.timezone ?? 'Europe/Moscow', people);
        const streamsById = new Map(streams.map(stream => [stream.id, stream]));
        for (const session of sessions) {
            const report = read(session), stream = streamsById.get(session.id);
            daily.add(report);
            if (stream) {
                const visitors = report.audience.filter(person => person.attendanceSessionIds.length).map(person => person.id);
                stream.core = visitors.filter(id => people.get(id)?.core).length;
                stream.newInPeriod = visitors.filter(id => people.firstVisit(id)).length;
                stream.returning = visitors.length - stream.newInPeriod;

            }
            this.checkWorkspace(workspace);
            processed++;
            if (performance.now() - sliceStart > 250) {
                yield { preparing: true, ready: processed, total: sessions.length * 2 };
                sliceStart = performance.now();
            }
        }
        const insights:InsightCard[]=[];
        if(insightBuilder)for(const card of insightBuilder.find()){
            if(card)insights.push(card);
            if(performance.now()-sliceStart>250){yield {preparing:true,ready:processed,total:sessions.length*2};sliceStart=performance.now();}
        }
        insights.sort((a,b)=>b.score-a.score||(a.personName??'').localeCompare(b.personName??'','ru',{numeric:true})||a.id.localeCompare(b.id));
        const audience=people.page().items;
        const outputCategories=[...categoryRows.values()].map(row=>({...row,...workspace.categoryCounts(row.id),donationsPerHourMinor:currencyRates(row.donationTotals,Math.round(row.minutes*60000)),messagesPerHour:row.minutes?row.messages*60/row.minutes:0,observedPerMinute:row.minutes?row.observedMinutes/row.minutes:0,observedPerKnownMinute:row.observedKnownMinutes?row.observedMinutes/row.observedKnownMinutes:null,coverageRatio:row.minutes?row.observedKnownMinutes/row.minutes:null}));
        for(const row of clockRows.values()){
            // Exact membership is retained in the workspace, not duplicated into
            // every resolution/day bucket. Resolve only the selected interval.
            row.peopleDeferred=true;
            row.averageAudience=row.airtimeMs?row.personTimeMs/row.airtimeMs:null;
        }
        const youtube = options.source !== 'twitch' && options.youtubeAccount ? this.statement("SELECT payload_json,updated_at_ms FROM youtube_snapshots WHERE account_id=? AND key='report'").get(options.youtubeAccount) as {
            payload_json: string;
            updated_at_ms: number;
        } | undefined : undefined;
        return { ...sample,insights:options.includeInsights?insights:[], activityClock:[...activityClock.values()], youtubeReport: youtube ? { data: JSON.parse(youtube.payload_json), updatedAt: youtube.updated_at_ms } : null, aggregate: true, filters: { ...validation.filters, fromMs: options.fromMs, toMs: options.toMs }, activityWindows: [], timeline: daily.values(), breaks: [], sessions: [sessions[0]!], audience, categories: outputCategories, availableCategories: [...categories.values()], streamComparison: streams, clockBuckets: [...clockRows.values()], hours: [...hours.values()], patterns: timePatterns([...hours.values()]), summary,composition,donationTiming:donationTiming(this.db,options.fromMs,options.toMs,options.timezone??'Europe/Moscow',options.category)};
    }
}
