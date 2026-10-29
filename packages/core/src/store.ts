import {AnalyticsReportCache} from './analytics-report-cache.js';
import {ChannelRecords} from './channel-records.js';
import {SubscriberHistory,type SubscriberQuery,type Publication} from './subscriber-history.js';
import {SessionGroups,logicalReadDatabase} from "./session-groups.js";
import {AnalyticsHistory} from "./analytics-history.js";
import {EventIngestion} from "./event-ingestion.js";
import {RecentEvents,type RecentFilter} from './recent-events.js';
export {priorModerationQuery} from "./event-ingestion.js";
import {StreamSessions} from "./stream-sessions.js";
import {IdentityLinks} from "./identity-links.js";
import {AudienceQueries} from "./audience-queries.js";
import {ProviderStorage} from "./provider-storage.js";
import {messageMetadata} from "./message-storage.js";
import {registerDonationSum,donationTotals} from './donation-statistics.js';
import {parseDonationTime} from './donation-time.js';
import {personActivity} from "./person-activity.js";
import {DonationLedger,type DonationInput} from "./donations.js";
import { audienceAnalytics,type AnalyticsOptions } from "./analytics.js";
import Database from "better-sqlite3";
import { createHash,randomUUID } from "node:crypto";
import { openProfileDatabase } from "./profile-db.js";
import {
  candidateKey,
  matchKey,
  assertTimestamp,
  type EventInput,
  type Source,
} from "./domain.js";
import {migrateDatabase} from "./database-migrations.js";
import {CURRENT_SCHEMA_VERSION} from "./schema.js";
import {PersonAnnotations} from "./person-annotations.js";
import {personFollowing,followingAnalytics,type Follower} from './following.js';
import { windowsFromLinks } from './session-windows.js';
import { type PresencePoll } from "./presence.js";


export class StreamStore {
  private history:AnalyticsHistory;
  private records:ChannelRecords;
  private overviewActivity:AnalyticsReportCache<{messages:number;attendees:number}>;
  private readonly reads:Database.Database;
  private readonly groups:SessionGroups;
  private readonly db: Database.Database;
  private readonly annotations:PersonAnnotations;
  private readonly eventIngestion:EventIngestion;
  private readonly streams:StreamSessions;
  private readonly links:IdentityLinks;
  private readonly queries:AudienceQueries;

  constructor(path: string, private readonly profile?: string) {
    this.db = openProfileDatabase(path, profile);
    this.reads=logicalReadDatabase(this.db);
    this.groups=new SessionGroups(this.db);
    this.annotations = new PersonAnnotations(this.db);
    this.streams=new StreamSessions(this.db,this.reads);
    this.links=new IdentityLinks(this.db,id=>this.annotations.personRevision(id));
    this.queries=new AudienceQueries(this.reads);
    this.eventIngestion=new EventIngestion(this.db,this.links,this.streams);
    registerDonationSum(this.db);
    try {
      migrateDatabase(this.db);
    this.history=new AnalyticsHistory(this.reads);
    this.overviewActivity=new AnalyticsReportCache(this.reads);
    this.records=new ChannelRecords(this.reads,(id,bots)=>({...this.streams.sessions(id,0,1,bots)[0],...this.history.recordMetrics(id,JSON.parse(bots) as string[])}));
      // Person = link umbrella. Collapse historical per-tip DA identity dupes.
      this.db.transaction(() => {this.collapseDuplicateDaDonors();this.reconcileNicknameLinks();}).immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private assignEvent(id: string, accountId: string, atMs: number) {return this.streams.assignEvent(id,accountId,atMs);}
  startSession(
    accountId: string,
    streamId: string,
    startedAtMs: number,
    kind: "platform" | "manual",
    nowMs: number,
  ) {return this.streams.startSession(accountId,streamId,startedAtMs,kind,nowMs);}
  endSession(id: string, atMs: number, quality = "observed") {return this.streams.endSession(id,atMs,quality);}
  deleteManualSession(id: string, atMs: number) {return this.streams.deleteManualSession(id,atMs);}
  sessions(sessionId?: string,offset=0,limit=100,excludedBotLogins:readonly string[]=[]) {
    return this.streams.sessions(sessionId?this.groups.root(sessionId):undefined,offset,limit,this.queries.botJson(excludedBotLogins));
  }
  mergeSessions(ids:string[]){return this.groups.merge(ids);}
  unmergeSessions(id:string){this.groups.unmerge(id);}
  platformStreams(sessionId: string) {return this.streams.platformStreams(sessionId);}
  platformMissing(platform: "twitch" | "youtube", accountId: string, presentIds: string[], observedAtMs: number) {return this.streams.platformMissing(platform,accountId,presentIds,observedAtMs);}
  attachPlatformStream(
    sessionId: string,
    platform: "twitch" | "youtube",
    accountId: string,
    externalId: string,
    startedAtMs: number,
    observedAtMs: number,
    url: string | null,
    title: string,
  ) {return this.streams.attachPlatformStream(sessionId,platform,accountId,externalId,startedAtMs,observedAtMs,url,title);}
  observePlatformStream(
    platform: "twitch" | "youtube",
    accountId: string,
    externalId: string,
    startedAtMs: number,
    observedAtMs: number,
    url: string | null,
    title: string,
    confirmedPresentIds?: string[],
  ) {return this.streams.observePlatformStream(platform,accountId,externalId,startedAtMs,observedAtMs,url,title,confirmedPresentIds);}
  activeLogicalStream() {return this.streams.activeLogicalStream();}
  changeStamp(){return (this.db.prepare('SELECT coalesce(sum(revision),0) value FROM ui_revisions').get() as {value:number}).value;}
  streamMatchContext(sessionId:string){
    const id=this.groups.root(sessionId);
    const row=this.reads.prepare(`SELECT s.started_at_ms startedAt,s.id=(SELECT x.id FROM sessions x WHERE NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=x.id) ORDER BY x.started_at_ms DESC,x.id LIMIT 1) latest FROM sessions s WHERE s.id=? AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=s.id)`).get(id) as {startedAt:number;latest:number}|undefined;
    return row?{startedAt:row.startedAt,latest:!!row.latest}:null;
  }
  matchingStream(startedAt:number,latest=false){
    if(!Number.isSafeInteger(startedAt)||startedAt<0)throw new Error('INVALID_STREAM_DATE');
    const where=latest?'':"AND date(s.started_at_ms/1000,'unixepoch','+3 hours')=date(?/1000,'unixepoch','+3 hours')";
    return (this.reads.prepare(`SELECT s.id FROM sessions s WHERE NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=s.id) ${where} ORDER BY ${latest?'s.started_at_ms DESC':"abs(s.started_at_ms-?),s.started_at_ms"},s.id LIMIT 1`).get(...(latest?[]:[startedAt,startedAt])) as {id:string}|undefined)?.id??null;
  }
  changes(sessionId?:string){
    const versions=Object.fromEntries((this.db.prepare('SELECT domain,revision FROM ui_revisions').all() as {domain:string;revision:number}[]).map(r=>[r.domain,r.revision]));
    const active=this.reads.prepare('SELECT id FROM sessions s WHERE ended_at_ms IS NULL AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=s.id) ORDER BY started_at_ms DESC LIMIT 1').get() as {id:string}|undefined;
    const selected=sessionId?this.groups.root(sessionId):'';
    const stream=selected?this.reads.prepare('SELECT s.id,s.ended_at_ms endedAt,coalesce((SELECT sum(v.activity+v.money) FROM analytics_fact_versions v WHERE v.session_id=s.id OR v.session_id IN(SELECT member_id FROM session_groups WHERE group_id=s.id)),0) revision FROM sessions s WHERE s.id=?').get(selected) as {id:string;endedAt:number|null;revision:number}|undefined:undefined;
    return {versions,activeStream:active?.id??null,stream:stream??null};
  }

  merge(
    sourceId: string,
    targetId: string,
    sourceRevision: number,
    targetRevision: number,
    nowMs: number,
  ) {return this.links.merge(sourceId,targetId,sourceRevision,targetRevision,nowMs);}
  undoMerge(mergeId: string, nowMs: number) {return this.links.undoMerge(mergeId,nowMs);}
  collapseDuplicateDaDonors() {return this.links.collapseDuplicateDaDonors();}
  private resolveAutoLinkPerson(
    source: Source | "youtube",
    accountId: string,
    _externalId: string,
    displayName: string,
  ) {return this.links.resolveAutoLinkPerson(source,accountId,_externalId,displayName);}
  private reconcileNicknameLinks(onlyKey?:string) {return this.links.reconcileNicknameLinks(onlyKey);}
  ensureOwnerIdentity(
    accountId: string,
    userId: string,
    displayName: string,
    atMs: number,
  ) {return this.links.ensureOwnerIdentity(accountId,userId,displayName,atMs);}
  candidatePersons(name: string) {return this.links.candidatePersons(name);}
  eventCount(personId?: string) {return this.links.eventCount(personId);}
  private rememberAlias(identityId: string, name: string, nowMs: number) {return this.links.rememberAlias(identityId,name,nowMs);}
  splitIdentities(
    ids: string[],
    name: string,
    sourceRevision: number,
    nowMs: number,
  ) {return this.links.splitIdentities(ids,name,sourceRevision,nowMs);}
  splits() {return this.links.splits();}
  undoSplit(id: string, atMs: number) {return this.links.undoSplit(id,atMs);}
  merges() {return this.links.merges();}
  persons(
    search = "",
    excludedBotLogins: readonly string[] = [],
    fromMs=0,
  ) {return this.queries.persons(search,excludedBotLogins,fromMs);}
  personsPage(search = "", excludedBotLogins: readonly string[] = [], fromMs=0, offset=0, limit=50) {
    return this.queries.personsPage(search,excludedBotLogins,fromMs,offset,limit);
  }
  person(id: string,includeEvents=true) {return this.queries.person(id,includeEvents);}
  events(
    sessionId?: string,
    personId?: string,
    fromMs?: number,
    toMs?: number,
    type?:string,
    source?:string,
  ) {return this.queries.events(sessionId?this.groups.root(sessionId):undefined,personId,fromMs,toMs,type,source);}
  recentEvents(offset=0,limit=100,filter:RecentFilter={}) {return new RecentEvents(this.db).list(offset,limit,Date.now(),{...filter,...(filter.session?{session:this.groups.root(filter.session)}:{})});}
  purgeRecentEvents() {return new RecentEvents(this.db).purge();}
  summary(
    sessionId?: string,
    excludedBotLogins: readonly string[] = [],
    details = true,
  ) {return this.queries.summary(sessionId?this.groups.root(sessionId):undefined,excludedBotLogins,details);}
  grid(
    sessionId: string,
    personId: string,
    fromMs: number,
    toMs: number,
  ) {return this.queries.grid(this.groups.root(sessionId),personId,fromMs,toMs);}
  private sessionRow(sessionId: string) {return this.queries.sessionRow(sessionId);}
  private botJson(excludedBotLogins: readonly string[] = []) {return this.queries.botJson(excludedBotLogins);}
  private notBotClause(alias = "i") {return this.queries.notBotClause(alias);}
  personStats(
    personId: string,
    sessionId?: string,
    excludedBotLogins: readonly string[] = [],
    chatWindowMinutes=5,
    fromMs=0,
  ) {return this.queries.personStats(personId,sessionId?this.groups.root(sessionId):undefined,excludedBotLogins,chatWindowMinutes,fromMs);}
  personsTop(
    sortBy: "messages" | "donations" | "observed_minutes" = "messages",
    sessionId?: string,
    excludedBotLogins: readonly string[] = [],
    limit = 50,
    fromMs=0,toMs?:number,currency='RUB',
  ) {return this.queries.personsTop(sortBy,sessionId?this.groups.root(sessionId):undefined,excludedBotLogins,limit,fromMs,toMs,currency);}
  insights(sessionId?:string,excludedBotLogins:readonly string[]=[],options:Partial<AnalyticsOptions>={}) {
    const id=sessionId?this.groups.root(sessionId):undefined;
    const session=id?this.reads.prepare('SELECT started_at_ms AS start,ended_at_ms AS end FROM sessions WHERE id=? AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=sessions.id)').get(id) as {start:number;end:number|null}|undefined:undefined;
    if(id&&!session)throw new Error('SESSION_NOT_FOUND');
    const now=Date.now(),to=session?Math.min(session.end??options.toMs??(now-session.start>=60000?Math.floor(now/60000)*60000:now),now,options.toMs??now):options.toMs??now;
    const settings={...options,fromMs:session?session.start:options.fromMs??0,toMs:to,excludedLogins:[...excludedBotLogins],includeInsights:true,...(id?{sessionId:id}:{})};
    const report=id?this.history.streamReport(settings):this.history.report(settings);
    return {insights:report.insights??[],preparing:report.preparing===true,comparisonToMs:to};
  }

  close(): void {
    this.history.close();
    this.db.close();
  }
  collectionLifecycle(action:'start'|'heartbeat'|'stop',at:number):void{
    assertTimestamp(at);
    if(!['start','heartbeat','stop'].includes(action))throw new Error('INVALID_COLLECTION_ACTION');
    this.db.transaction(()=>{
      const previous=this.db.prepare('SELECT last_seen_ms,running FROM collector_state WHERE id=1').get() as {last_seen_ms:number;running:number}|undefined;
      if(previous&&at<previous.last_seen_ms)throw new Error('STALE_COLLECTION_STATE');
      if(action==='start'&&previous){
        const open=this.db.prepare("UPDATE collection_gaps SET ended_at_ms=? WHERE source='collector' AND reason='collector_stopped' AND ended_at_ms IS NULL").run(at);
        if(!open.changes&&previous.running)this.gap('collector','collector_restarted',previous.last_seen_ms,at);
      }
      if(action==='stop'&&previous?.running)this.gap('collector','collector_stopped',at,null);
      this.db.prepare('INSERT INTO collector_state VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET last_seen_ms=excluded.last_seen_ms,running=excluded.running').run(at,Number(action!=='stop'));
    }).immediate();
  }

  donorNicknames(){
    return this.db.prepare("SELECT match_key AS key,max(display_name) AS name,count(*) AS accounts FROM identities WHERE source='donationalerts' AND match_key!='' AND external_id!='anonymous:donor' AND account_id NOT LIKE 'manual:%' AND account_id NOT LIKE 'correction:%' GROUP BY match_key ORDER BY name").all() as {key:string;name:string;accounts:number}[];
  }
  donorBindings(person:string){
    this.personRevision(person);
    return this.db.prepare('SELECT b.name_key AS key,b.name,b.updated_at_ms AS at FROM donor_bindings b LEFT JOIN identities i ON i.id=b.identity_id WHERE coalesce(i.person_id,b.person_id)=? ORDER BY b.name').all(person) as {key:string;name:string;at:number}[];
  }
  bindDonorNickname(person:string,name:string,revision:number,at:number){
    assertTimestamp(at);const key=matchKey(name);
    if(!key||name.length>200||['аноним','anonymous','anon'].includes(key))throw new Error('INVALID_DONOR_NICKNAME');
    return this.db.transaction(()=>{
      if(this.personRevision(person)!==revision)throw new Error('REVISION_CONFLICT');
      const members=this.db.prepare("SELECT id,person_id AS personId FROM identities WHERE source='donationalerts' AND match_key=? AND account_id NOT LIKE 'manual:%' AND account_id NOT LIKE 'correction:%' UNION SELECT i.id,i.person_id FROM identities i JOIN donation_corrections c ON c.identity_id=i.id JOIN events e ON e.id=c.event_id JOIN identities original ON original.id=e.identity_id WHERE e.source='donationalerts' AND original.match_key=?").all(key,key) as {id:string;personId:string}[];
      const anchor=members[0]?.id??null;
      for(const member of members)this.db.prepare('UPDATE identities SET person_id=? WHERE id=?').run(person,member.id);
      const affected=JSON.stringify([...new Set([person,...members.map(m=>m.personId)])]);
      this.db.prepare('UPDATE persons SET revision=revision+1 WHERE id IN(SELECT value FROM json_each(?))').run(affected);
      this.db.prepare('INSERT INTO donor_bindings VALUES (?,?,?,?,?) ON CONFLICT(name_key) DO UPDATE SET name=excluded.name,person_id=excluded.person_id,identity_id=excluded.identity_id,updated_at_ms=excluded.updated_at_ms').run(key,name.trim(),person,anchor,at);
      this.db.prepare('INSERT INTO membership_operations VALUES (?,?,?,?,?)').run(randomUUID(),'donor_bind',JSON.stringify(members),JSON.stringify({key,personId:person}),at);
      return this.donorBindings(person);
    }).immediate();
  }

  personActivity(id:string,chatWindowMinutes=5,timezone="Europe/Moscow"){return personActivity(this.reads,id,chatWindowMinutes,timezone);}
  donation(id:string) {return new DonationLedger(this.db).donation(id);}
  donations(personId?:string,offset=0,limit=50,includeDeleted=false,sessionId?:string) {return new DonationLedger(this.reads).list(personId,offset,limit,includeDeleted,sessionId?this.groups.root(sessionId):undefined);}
  resolveDonationTimes(offset:number) {
    if(!Number.isInteger(offset)||Math.abs(offset)>840)throw new Error('INVALID_UTC_OFFSET');
    return this.db.transaction(()=>{
      const rows=this.db.prepare("SELECT id,account_id,source_time,occurred_at_ms FROM events WHERE source='donationalerts' AND type='donation' AND account_id!='manual' AND source_time IS NOT NULL").all() as {id:string;account_id:string;source_time:string;occurred_at_ms:number|null}[];
      let resolved=0,invalid=0;
      for(const row of rows){
        let at:number|null;try{at=parseDonationTime(row.source_time,offset);}catch{invalid++;continue;}
        if(at===null)continue;
        const originalChanged=at!==row.occurred_at_ms;
        if(originalChanged)this.db.prepare("UPDATE events SET occurred_at_ms=?,time_quality='configured' WHERE id=?").run(at,row.id);
        // A text/amount edit can carry forward an unknown date. Preserve only actual time edits.
        const correctionChanged=this.db.prepare(`UPDATE donation_corrections SET occurred_at_ms=? WHERE event_id=? AND occurred_at_ms IS NOT ? AND (
          coalesce(json_extract(payload_json,'$.corrected'),0)=0 OR (
            EXISTS(SELECT 1 FROM donation_audit a WHERE a.event_id=donation_corrections.event_id AND a.kind='update') AND
            NOT EXISTS(SELECT 1 FROM donation_audit a WHERE a.event_id=donation_corrections.event_id AND a.kind='update' AND (
              json_type(a.before_json,'$.occurredAtMs') IS NULL OR json_type(a.after_json,'$.occurredAtMs') IS NULL OR
              json_extract(a.before_json,'$.occurredAtMs') IS NOT json_extract(a.after_json,'$.occurredAtMs')
            ))
          ))`).run(at,row.id,at).changes>0;
        if(!originalChanged&&!correctionChanged)continue;
        const effective=this.db.prepare('SELECT occurred_at_ms FROM effective_events WHERE id=?').get(row.id) as {occurred_at_ms:number|null}|undefined;
        if(effective?.occurred_at_ms!=null){this.db.prepare('DELETE FROM event_sessions WHERE event_id=?').run(row.id);this.assignEvent(row.id,row.account_id,effective.occurred_at_ms);}
        resolved++;
      }
      return {resolved,invalid};
    }).immediate();
  }
  createDonation(input:DonationInput,atMs:number) {return new DonationLedger(this.db).create(input,atMs);}
  updateDonation(id:string,input:DonationInput,revision:number,atMs:number) {return new DonationLedger(this.db).update(id,input,revision,atMs);}
  deleteDonation(id:string,revision:number,atMs:number):void {new DonationLedger(this.db).remove(id,revision,atMs);}
  restoreDonation(id:string,revision:number,atMs:number) {return new DonationLedger(this.db).restore(id,revision,atMs);}
  reassignDonation(id:string,personId:string|null,revision:number,atMs:number) {return new DonationLedger(this.db).reassign(id,personId,revision,atMs);}
  donationAudit(id:string) {return new DonationLedger(this.db).auditHistory(id);}

  streamSample(sessionId: string, at: number, categoryId: string, categoryName: string, title: string, twitchViewers: number | null): void {
    assertTimestamp(at);
    if ([categoryId,categoryName,title].some(s => s.length > 1000) || (twitchViewers !== null && (!Number.isSafeInteger(twitchViewers) || twitchViewers < 0))) throw new Error("INVALID_STREAM_SAMPLE");
    this.db.prepare("INSERT INTO stream_samples VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(session_id,observed_at_ms) DO UPDATE SET category_id=excluded.category_id,category_name=excluded.category_name,title=excluded.title,twitch_viewers=excluded.twitch_viewers").run(sessionId,at,categoryId,categoryName,title,twitchViewers);
  }
  youtubeViewers(at: number, viewers: number | null, sessionId?: string | null): void {
    assertTimestamp(at);
    if (viewers !== null && (!Number.isSafeInteger(viewers) || viewers < 0)) throw new Error("INVALID_VIEWER_COUNT");
    if (sessionId === null) return; // Unknown start time: preserve raw details without attributing another stream.
    if (sessionId !== undefined) {
      const session = this.db.prepare("SELECT id FROM sessions WHERE id=? AND ended_at_ms IS NULL AND EXISTS(SELECT 1 FROM platform_streams WHERE session_id=sessions.id AND platform='youtube' AND ended_at_ms IS NULL)").get(sessionId);
      if (!session) throw new Error("INVALID_YOUTUBE_SESSION");
      this.db.prepare("INSERT INTO stream_samples(session_id,observed_at_ms,category_id,category_name,title,twitch_viewers,youtube_viewers) VALUES (?,?,'','','',NULL,?) ON CONFLICT(session_id,observed_at_ms) DO UPDATE SET youtube_viewers=excluded.youtube_viewers").run(sessionId,at,viewers);
      return;
    }
    // Join only the latest contemporaneous Twitch sample; never borrow an old category.
    this.db.prepare("INSERT INTO stream_samples SELECT x.session_id,?,x.category_id,x.category_name,x.title,NULL,? FROM stream_samples x JOIN sessions s ON s.id=x.session_id WHERE s.ended_at_ms IS NULL AND x.twitch_viewers IS NOT NULL AND x.observed_at_ms<=? AND x.observed_at_ms>=? ORDER BY x.observed_at_ms DESC LIMIT 1 ON CONFLICT(session_id,observed_at_ms) DO UPDATE SET youtube_viewers=excluded.youtube_viewers").run(at,viewers,at,at-180000);
  }
  channelOverview(excludedBotLogins:readonly string[]=[]){
    const sessions=this.reads.prepare("SELECT id,started_at_ms AS start,ended_at_ms AS end FROM sessions s WHERE NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=s.id)").all() as {id:string;start:number;end:number|null}[];
    const excluded=this.botJson(excludedBotLogins);
    const revision=this.reads.prepare("SELECT revision FROM ui_revisions WHERE domain='overviewAttendance'").get();
    const scope=createHash('sha256').update('overview-attendance-v2:'+excluded).digest('hex'),key=createHash('sha256').update(JSON.stringify([scope,revision])).digest('hex');
    let activity=this.overviewActivity.get(key);
    if(!activity){
      const summary=this.summary(undefined,excludedBotLogins);
      const attendees=(this.reads.prepare(`SELECT count(*) AS n FROM (
        SELECT i.person_id FROM presence_members m JOIN presence_polls p ON p.id=m.poll_id JOIN identities i ON i.id=m.identity_id WHERE p.status='complete' AND ${this.notBotClause('i')} AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=p.session_id)
        UNION SELECT value FROM json_each(?)
      )`).get(excluded,JSON.stringify((summary.participants as {personId:string}[]).map(p=>p.personId))) as {n:number}).n;
      activity={messages:Number(summary.messages),attendees};this.overviewActivity.save(key,scope,activity);
    }
    const donations=(this.reads.prepare("SELECT count(*) n FROM effective_events e LEFT JOIN identities i ON i.id=e.identity_id WHERE e.type='donation' AND (i.id IS NULL OR i.match_key NOT IN(SELECT value FROM json_each(?)))").get(excluded) as {n:number}).n;
    const links=this.reads.prepare('SELECT session_id,started_at_ms,ended_at_ms FROM platform_streams').all() as {session_id:string;started_at_ms:number;ended_at_ms:number|null}[];
    const windowsBySession=new Map<string,typeof links>();for(const link of links){const list=windowsBySession.get(link.session_id)??[];list.push(link);windowsBySession.set(link.session_id,list);}
    const now=Date.now(),totals30=donationTotals(this.reads,now-30*86400000,now,excluded);
    return {records:this.records.read(excluded),totals30,streams:sessions.length,durationMinutes:sessions.reduce((n,s)=>n+windowsFromLinks(windowsBySession.get(s.id)??[],s.start,s.end??Date.now()).reduce((m,w)=>m+(w.to-w.from)/60000,0),0),attendees:activity.attendees,messages:activity.messages,totals:donationTotals(this.reads,undefined,undefined,excluded),donations};
  }
  personAnalytics(id:string,options:AnalyticsOptions){
    return this.reads.transaction(()=>{
    this.queries.person(id,false);
    const report=audienceAnalytics(this.reads,{...options,personId:id,activityOnly:true});
    return {filters:report.filters,audience:report.audience,timeline:report.timeline.map(p=>({at:p.at,presenceKnown:p.presenceKnown})),aggregate:false};
    })();
  }
  personOptions(search='',offset=0,limit=50,includeBots=false,selected='',excluded:readonly string[]=[],exclude=''){return this.queries.personOptions(search,offset,limit,includeBots,selected,excluded,exclude);}

  analytics(options: AnalyticsOptions):ReturnType<AnalyticsHistory['query']> {
    return this.history.query(options.sessionId?{...options,sessionId:this.groups.root(options.sessionId)}:options);
  }

  clockAudience(options:AnalyticsOptions){return this.history.clockAudience(options);}
  advanceAnalytics(options:AnalyticsOptions){return this.history.advance(options);}
  warmAnalytics(options:AnalyticsOptions,bakeCategories=false){const result=this.history.warm(options,bakeCategories);if(!result.preparing)this.channelOverview(options.excludedLogins);return result;}

  youtubeQuota(day: string, profile: string, cost = 1): boolean {
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(day) || !profile || !Number.isInteger(cost) || cost < 1 || cost > 4000) throw new Error("INVALID_QUOTA");
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT used FROM sp_youtube_quota WHERE day=? AND profile=?").get(day, profile) as {used: number} | undefined;
      if ((row?.used ?? 0) + cost > 4000) return false;
      this.db.prepare("INSERT INTO sp_youtube_quota VALUES (?,?,?) ON CONFLICT(day,profile) DO UPDATE SET used=used+excluded.used").run(day, profile, cost);
      this.db.prepare("DELETE FROM sp_youtube_quota WHERE day!=?").run(day);
      return true;
    }).immediate();
  }
  youtubeSnapshot(account: string, key: string, payload: unknown, now = Date.now()): void {
    if (!account || !key) throw new Error("INVALID_YOUTUBE_KEY");
    if(key.startsWith("chat:")||key.startsWith("api:"))return;
    this.db.transaction(()=>{
      this.db.prepare("INSERT INTO youtube_snapshots VALUES (?,?,?,?) ON CONFLICT(account_id,key) DO UPDATE SET payload_json=excluded.payload_json,updated_at_ms=excluded.updated_at_ms").run(account, key, JSON.stringify(payload), now);
      if(key==='channel'){
        const stats=(payload as {statistics?:{subscriberCount?:unknown;hiddenSubscriberCount?:boolean}})?.statistics;
        const count=stats?.subscriberCount;
        if(stats?.hiddenSubscriberCount!==true&&typeof count==='string'&&/^\d+$/.test(count)&&Number.isSafeInteger(Number(count)))new SubscriberHistory(this.db).count('youtube',account,Number(count),now);
      }

    }).immediate();
  }
  providerSnapshot(source:string,account:string,key:string,payload:unknown,at:number,sessionId:string|null=null):void {
    assertTimestamp(at);
    if(!['twitch','youtube','donationalerts'].includes(source)||!account||!key)throw new Error('INVALID_PROVIDER_SNAPSHOT');
    if(key!=='followers')return;
    const data=payload as {followers:Follower[];complete:boolean;total:number|null};
    new ProviderStorage(this.db).saveFollowers(source,account,data,at,sessionId);
  }
  donationImportStates(account:string,ids:string[]){return new ProviderStorage(this.db).donationStates(account,ids);}
  pendingDonationImportCount(account:string){return new ProviderStorage(this.db).pendingCount(account);}
  pendingDonationImports(account:string){return new ProviderStorage(this.db).pending(account);}
  saveDonationImportFailure(account:string,serialized:string,error:string,at:number){new ProviderStorage(this.db).saveFailure(account,serialized,error,at);}
  removePendingDonation(account:string,id:string){new ProviderStorage(this.db).removePending(account,id);}

  followingSnapshot(source:'twitch'|'youtube',account:string,followers:Follower[],complete:boolean,at:number,total:number|null=null):void {
    if(!['twitch','youtube'].includes(source)||!account||typeof complete!=='boolean'||followers.length>25000||total!==null&&(!Number.isSafeInteger(total)||total<0))throw new Error('INVALID_FOLLOWERS');
    for(const follower of followers){if(!follower.id||typeof follower.name!=='string')throw new Error('INVALID_FOLLOWERS');if(follower.followedAtMs!==null)assertTimestamp(follower.followedAtMs);}
    this.db.transaction(()=>{
      this.providerSnapshot(source,account,'followers',{followers:[...new Map(followers.map(f=>[f.id,f])).values()],complete,total},at);
      if(source==='twitch'&&total!==null)new SubscriberHistory(this.db).count(source,account,total,at);
    }).immediate();
  }
  subscriberHistory(query:SubscriberQuery){return new SubscriberHistory(this.db).query(query);}
  youtubePublications(account:string,items:Publication[],at:number){new SubscriberHistory(this.db).publications(account,items,at);}
  personFollowing(personId:string,sessionId=''){sessionId=sessionId?this.groups.root(sessionId):'';if(!this.db.prepare('SELECT 1 FROM persons WHERE id=?').get(personId))throw new Error('PERSON_NOT_FOUND');if(sessionId)this.sessionRow(sessionId);return personFollowing(this.reads,personId,sessionId);}
  followingAnalytics(sessionId:string){sessionId=this.groups.root(sessionId);this.sessionRow(sessionId);return followingAnalytics(this.reads,sessionId);}
  streamMetadata(sessionId:string){
    sessionId=this.groups.root(sessionId);this.sessionRow(sessionId);
    return this.reads.prepare(`SELECT observed_at_ms AS at,category_id AS categoryId,category_name AS categoryName,title
      FROM stream_samples WHERE session_id=? AND (twitch_viewers IS NOT NULL OR category_id<>'' OR title<>'') ORDER BY observed_at_ms`).all(sessionId);
  }
  youtubeMessages(account: string, chat: string, messages: any[],videoId?:string): void {
    if (!account || !chat || messages.length > 2000) throw new Error("INVALID_YOUTUBE_MESSAGES");
    this.db.transaction(() => {

      const insert = this.db.prepare("INSERT OR IGNORE INTO youtube_messages VALUES (?,?,?,?,?,?)");
      for (const m of messages) {
        const time = Date.parse(m.snippet?.publishedAt ?? "");
        if (!m.id || !Number.isFinite(time)) continue;
        if (m.snippet.type === "messageDeletedEvent") {
          const deletedMessageId = m.snippet.messageDeletedDetails?.deletedMessageId;
          if (typeof deletedMessageId === "string" && deletedMessageId.trim()) {
            this.db.prepare("DELETE FROM youtube_messages WHERE account_id=? AND id=?").run(account, deletedMessageId);
            new RecentEvents(this.db).removeYoutube(account,deletedMessageId);
          }
        }
        if (m.snippet.type === "userBannedEvent") {
          const bannedChannelId = m.snippet.userBannedDetails?.bannedUserDetails?.channelId;
          if (typeof bannedChannelId === "string" && bannedChannelId.trim()) {
            this.db.prepare("DELETE FROM youtube_messages WHERE account_id=? AND author_id=?").run(account, bannedChannelId);
            new RecentEvents(this.db).removeYoutube(account,undefined,bannedChannelId);
          }
        }
        if (insert.run(m.id, account, chat, m.authorDetails?.channelId ?? "", time, JSON.stringify(messageMetadata(m))).changes) {
          this.ensureYoutubeIdentity(account,m.authorDetails,time);
          const {displayMessage,textMessageDetails,...snippet}=m.snippet;
          new RecentEvents(this.db).save({source:'youtube',accountId:account,externalId:m.id,type:m.snippet.type,
            actor:m.authorDetails?.channelId?{externalId:m.authorDetails.channelId,displayName:m.authorDetails.displayName??m.authorDetails.channelId}:null,
            occurredAtMs:time,receivedAtMs:Date.now(),payload:{...snippet,chatId:chat,...(videoId?{videoId}:{}),text:displayMessage??textMessageDetails?.messageText??''}});
        }
      }
    }).immediate();
  }
  private ensureYoutubeIdentity(account: string, author: any, at: number): void {
    const externalId = author?.channelId;
    if (typeof externalId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(externalId)) return;
    const name = typeof author.displayName === "string" && author.displayName.trim()
      ? author.displayName.trim().slice(0,200) : externalId;
    let identity = this.db.prepare("SELECT id,person_id FROM youtube_identities WHERE account_id=? AND external_id=?").get(account,externalId) as {id:string;person_id:string}|undefined;
    if (!identity) {
      const prior = this.db.prepare("SELECT person_id FROM youtube_identities WHERE external_id=? ORDER BY id LIMIT 1").get(externalId) as {person_id:string}|undefined;
      const linked=this.resolveAutoLinkPerson("youtube",account,externalId,name);
      const personId = prior?.person_id ?? linked?.personId ?? `youtube:${externalId}`;
      this.db.prepare("INSERT OR IGNORE INTO persons VALUES (?,?,0)").run(personId,name);
      identity = {id:`youtube:${account}:${externalId}`,person_id:personId};
      this.db.prepare("INSERT INTO youtube_identities VALUES (?,?,?,?,?,?,?)").run(identity.id,account,externalId,name,matchKey(name),personId,Number(author.isChatOwner===true));
      this.db.prepare("UPDATE persons SET revision=revision+1 WHERE id=?").run(personId);
    } else this.db.prepare("UPDATE youtube_identities SET display_name=?,match_key=?,is_owner=MAX(is_owner,?) WHERE id=?").run(name,matchKey(name),Number(author.isChatOwner===true),identity.id);
    this.db.prepare("INSERT INTO youtube_identity_aliases VALUES (?,?,?,?,?) ON CONFLICT(identity_id,name) DO UPDATE SET first_seen_ms=MIN(first_seen_ms,excluded.first_seen_ms),last_seen_ms=MAX(last_seen_ms,excluded.last_seen_ms)").run(identity.id,name,matchKey(name),at,at);
  }
  youtubeData(account: string) {
    const snapshots = this.db.prepare("SELECT key,payload_json,updated_at_ms FROM youtube_snapshots WHERE account_id=?").all(account) as {key:string;payload_json:string;updated_at_ms:number}[];
    const messages = this.db.prepare("SELECT id,payload_json FROM youtube_messages WHERE account_id=? ORDER BY published_at_ms DESC,id DESC LIMIT 200").all(account) as {id:string;payload_json:string}[];
    const subscriberCountAt=(this.db.prepare("SELECT observed_at_ms AS at FROM subscriber_counts WHERE source='youtube' AND account_id=? ORDER BY observed_at_ms DESC LIMIT 1").get(account) as {at:number}|undefined)?.at??null;
    return { subscriberCountAt, snapshots: Object.fromEntries(snapshots.map(r => [r.key, {data: JSON.parse(r.payload_json), updatedAt: r.updated_at_ms}])), messages: messages.map(r => ({...JSON.parse(r.payload_json),id:r.id})) };
  }

  ingest(event:EventInput) {return this.eventIngestion.ingest(event);}

  createPerson(name:string): Record<string,unknown> {
    if(typeof name!=="string"||!name.trim()||name.length>200)throw new Error("INVALID_NAME");
    return this.db.transaction(()=>{
      const id=randomUUID();this.db.prepare("INSERT INTO persons(id,display_name) VALUES (?,?)").run(id,name.trim());
      // An explicit card remains visible before its first identity/event arrives.
      // Null keeps the normal automatic core criteria; no viewing fact is invented.
      this.db.prepare("INSERT INTO person_preferences(person_id,manual_core) VALUES (?,NULL)").run(id);
      return this.person(id);
    }).immediate();
  }

  personMetadata(personId:string) {return this.annotations.personMetadata(personId);}
  setPersonMetadata(personId:string,tags:string[],manualCore:boolean|null,revision:number) {return this.annotations.setPersonMetadata(personId,tags,manualCore,revision);}
  personNotes(personId:string) {return this.annotations.personNotes(personId);}
  createPersonNote(personId:string,body:string,nowMs=Date.now()) {return this.annotations.createPersonNote(personId,body,nowMs);}
  updatePersonNote(personId:string,id:string,body:string,revision:number,nowMs=Date.now()) {return this.annotations.updatePersonNote(personId,id,body,revision,nowMs);}
  deletePersonNote(personId:string,id:string,revision:number):void {this.annotations.deletePersonNote(personId,id,revision);}
  personRevision(id:string):number {return this.annotations.personRevision(id);}

  ingestLiveDonation(event:EventInput,expectedSessionId:string,allowUnknownTime=false) {return this.eventIngestion.ingestLiveDonation(event,expectedSessionId,allowUnknownTime);}

  donationCandidates(id:string,excludedBotLogins:readonly string[]=[]):{id:string;name:string;messages:number;lastMessageAt:number}[]{
    const donation=this.donation(id);
    // Unknown timestamps cannot establish a reliable ±2 minute window.
    if(donation.occurredAtMs===null)return [];
    const at=donation.occurredAtMs,botJson=this.botJson(excludedBotLogins);
    return this.db.prepare(`WITH nearby AS (
      SELECT i.person_id AS id,p.display_name AS name,e.occurred_at_ms AS at
      FROM effective_events e JOIN identities i ON i.id=e.identity_id JOIN persons p ON p.id=i.person_id
      WHERE e.type='chat.message' AND e.occurred_at_ms BETWEEN ? AND ? AND ${this.notBotClause('i')}
        AND (json_extract(e.payload_json,'$.originChannelId') IS NULL OR json_extract(e.payload_json,'$.originChannelId')=e.account_id)
        AND EXISTS(SELECT 1 FROM event_sessions chat JOIN event_sessions tip ON tip.session_id=chat.session_id WHERE chat.event_id=e.id AND tip.event_id=?)
      UNION ALL
      SELECT y.person_id,p.display_name,m.published_at_ms
      FROM youtube_messages m JOIN youtube_identities y ON y.account_id=m.account_id AND y.external_id=m.author_id JOIN persons p ON p.id=y.person_id
      WHERE m.published_at_ms BETWEEN ? AND ? AND json_extract(m.payload_json,'$.snippet.type')='textMessageEvent'
        AND NOT EXISTS(SELECT 1 FROM youtube_identities z LEFT JOIN youtube_identity_aliases a ON a.identity_id=z.id WHERE z.person_id=y.person_id AND (z.is_owner=1 OR z.external_id=z.account_id OR z.match_key IN(SELECT value FROM json_each(?)) OR a.match_key IN(SELECT value FROM json_each(?))))
        AND EXISTS(SELECT 1 FROM platform_streams ps JOIN event_sessions tip ON tip.session_id=ps.session_id WHERE tip.event_id=? AND ps.platform='youtube' AND ps.account_id=m.account_id AND ps.started_at_ms<=m.published_at_ms AND (ps.ended_at_ms IS NULL OR ps.ended_at_ms>m.published_at_ms))
    ) SELECT id,name,count(*) AS messages,max(at) AS lastMessageAt FROM nearby GROUP BY id ORDER BY min(abs(at-?)),messages DESC,id LIMIT 100`).all(at-120000,at+120000,botJson,id,at-120000,at+120000,botJson,botJson,id,at) as {id:string;name:string;messages:number;lastMessageAt:number}[];
  }

  recordPoll(sessionId: string, accountId: string, poll: PresencePoll): void {
    assertTimestamp(poll.startedAtMs);
    assertTimestamp(poll.completedAtMs);
    if (poll.completedAtMs < poll.startedAtMs)
      throw new Error("INVALID_POLL_WINDOW");
    this.db.transaction(() => {
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO presence_polls VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          id,
          sessionId,
          accountId,
          poll.startedAtMs,
          poll.completedAtMs,
          poll.status,
        );
      const lookup = this.db.prepare(
        "SELECT id FROM identities WHERE source='twitch' AND account_id=? AND external_id=?",
      );
      const insertPerson = this.db.prepare(
        "INSERT INTO persons VALUES (?, ?, 1)",
      );
      const insertIdentity = this.db.prepare(
        "INSERT INTO identities(id, source, account_id, external_id, display_name, candidate_key, person_id, match_key) VALUES (?, 'twitch', ?, ?, ?, ?, ?, ?)",
      );
      const insertMember = this.db.prepare(
        "INSERT INTO presence_members VALUES (?, ?)",
      );
      for (const userId of new Set(poll.userIds)) {
        let identity = lookup.get(accountId, userId) as
          | { id: string }
          | undefined;
        if (!identity) {
          const name=poll.userNames?.[userId] || userId;
          const linked=poll.userNames?.[userId]?this.resolveAutoLinkPerson("twitch",accountId,userId,name):null;
          const personId = linked?.personId??randomUUID();
          identity = { id: randomUUID() };
          if(!linked)insertPerson.run(personId, name);
          else this.db.prepare("UPDATE persons SET revision=revision+1 WHERE id=?").run(personId);
          insertIdentity.run(
            identity.id,
            accountId,
            userId,
            name,
            candidateKey(name),
            personId,
            matchKey(name),
          );
        }
        insertMember.run(id, identity.id);
      }
      if (poll.userNames) this.updateChatterNames(accountId,Object.entries(poll.userNames).map(([user_id,user_name])=>({user_id,user_name})),poll.completedAtMs);
    }).immediate();
  }

  updateChatterNames(
    accountId: string,
    users: { user_id: string; user_name: string }[],
    atMs: number,
  ): void {
    this.db.transaction(() => {
      for (const user of users) {
        const identity = this.db
          .prepare(
            "SELECT id, person_id, display_name FROM identities WHERE source='twitch' AND account_id=? AND external_id=?",
          )
          .get(accountId, user.user_id) as
          | { id: string; person_id: string; display_name: string }
          | undefined;
        if (!identity) continue;
        this.db
          .prepare(
            "UPDATE identities SET display_name=?, candidate_key=?, match_key=? WHERE id=?",
          )
          .run(user.user_name, candidateKey(user.user_name), matchKey(user.user_name), identity.id);
        this.db
          .prepare(
            "UPDATE persons SET display_name=? WHERE id=? AND display_name=?",
          )
          .run(user.user_name, identity.person_id, identity.display_name);
        this.rememberAlias(identity.id, user.user_name, atMs);
        this.reconcileNicknameLinks(matchKey(user.user_name));
      }
    }).immediate();
  }

  renamePerson(id: string, name: string): void {
    if (!name.trim() || name.length > 200) throw new Error("INVALID_NAME");
    if (
      !this.db
        .prepare("UPDATE persons SET display_name=? WHERE id=?")
        .run(name.trim(), id).changes
    )
      throw new Error("PERSON_NOT_FOUND");
  }

  gap(
    source: string,
    reason: string,
    fromMs: number,
    toMs: number | null,
  ): void {
    assertTimestamp(fromMs);
    if (toMs !== null) assertTimestamp(toMs);
    this.db
      .prepare("INSERT INTO collection_gaps VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), source, reason, fromMs, toMs);
  }

  gaps(): Record<string, unknown>[] {
    return this.db
      .prepare(
        "SELECT * FROM collection_gaps ORDER BY started_at_ms DESC LIMIT 50",
      )
      .all() as Record<string, unknown>[];
  }

  // SQLite online backup API, not copying a live WAL database file.
  async backup(path: string): Promise<void> {
    await this.db.backup(path);
    const snapshot = new Database(path, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      if (
        snapshot.pragma("integrity_check", { simple: true }) !== "ok" ||
        (snapshot.pragma("foreign_key_check") as unknown[]).length ||
        (this.profile ? (snapshot.prepare("SELECT version FROM sp_profile_schema WHERE profile=?").get(this.profile) as {version:number} | undefined)?.version : snapshot.pragma("user_version", { simple: true })) !== CURRENT_SCHEMA_VERSION
      )
        throw new Error("BACKUP_VALIDATION_FAILED");
    } finally {
      snapshot.close();
    }
  }
}


