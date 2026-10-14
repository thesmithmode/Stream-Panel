import type Database from "better-sqlite3";
import {randomUUID} from "node:crypto";
import {assertTimestamp} from "./domain.js";
import {streamMetrics} from "./stream-metrics.js";
import {windowsFromLinks,sessionBreaks} from "./session-windows.js";

/** Owns broadcast lifecycle and event attribution on the shared profile connection. */
export class StreamSessions {
  constructor(private readonly db:Database.Database) {}

  assignEvent(id: string, accountId: string, atMs: number): void {
    // v1 has one Twitch channel: known-time DA facts share that channel's session.
    const source = (
      this.db.prepare("SELECT source FROM events WHERE id=?").get(id) as {
        source: string;
      }
    ).source;
    const session = this.db
      .prepare(
        `SELECT id FROM sessions WHERE (account_id = ? OR kind = 'manual' OR ? = 'donationalerts' OR EXISTS(SELECT 1 FROM platform_streams p WHERE p.session_id=sessions.id AND p.account_id=? AND p.platform=? AND p.started_at_ms<=? AND (p.ended_at_ms IS NULL OR p.ended_at_ms>?)))
      AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=sessions.id) AND started_at_ms <= ? AND (ended_at_ms IS NULL OR ended_at_ms > ?) ORDER BY kind='platform' DESC, started_at_ms DESC LIMIT 1`,
      )
      .get(accountId, source, accountId, source, atMs, atMs, atMs, atMs) as { id: string } | undefined;
    if (session)
      this.db
        .prepare("INSERT OR REPLACE INTO event_sessions VALUES (?, ?)")
        .run(id, session.id);
  }

  startSession(
    accountId: string,
    streamId: string,
    startedAtMs: number,
    kind: "platform" | "manual",
    nowMs: number,
  ): string {
    assertTimestamp(startedAtMs);
    assertTimestamp(nowMs);
    return this.db.transaction(() => {
      const prior = this.db
        .prepare(
          "SELECT id FROM sessions WHERE account_id = ? AND stream_id = ?",
        )
        .get(accountId, streamId) as { id: string } | undefined;
      if (prior) {
        if (kind === "platform") this.db.prepare(`
          INSERT OR IGNORE INTO platform_streams
            (platform,account_id,external_id,session_id,started_at_ms,ended_at_ms,last_observed_at_ms)
          SELECT 'twitch',account_id,stream_id,id,started_at_ms,ended_at_ms,recording_started_at_ms
          FROM sessions WHERE id=? AND kind='platform'
        `).run(prior.id);
        return prior.id;
      }
      const closed = this.db
        .prepare(
          "UPDATE sessions SET ended_at_ms = ?, end_quality = 'estimated' WHERE account_id = ? AND ended_at_ms IS NULL",
        )
        .run(startedAtMs, accountId);
      if (closed.changes) this.db.prepare("UPDATE platform_streams SET ended_at_ms=? WHERE session_id IN (SELECT id FROM sessions WHERE account_id=? AND ended_at_ms=? AND end_quality='estimated') AND ended_at_ms IS NULL").run(startedAtMs, accountId, startedAtMs);
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, NULL, 'unknown')",
        )
        .run(id, accountId, streamId, kind, startedAtMs, nowMs);
      if (kind === "platform") this.db.prepare(`
        INSERT OR IGNORE INTO platform_streams
          (platform,account_id,external_id,session_id,started_at_ms,ended_at_ms,last_observed_at_ms)
        VALUES ('twitch',?,?,?, ?,NULL,?)
      `).run(accountId, streamId, id, startedAtMs, nowMs);
      const events = this.db
        .prepare(
          "SELECT id, account_id, occurred_at_ms FROM effective_events WHERE (account_id = ? OR source='donationalerts' OR ?='manual') AND occurred_at_ms >= ?",
        )
        .all(accountId, kind, startedAtMs) as {
        id: string;
        account_id: string;
        occurred_at_ms: number;
      }[];
      for (const event of events)
        this.assignEvent(event.id, event.account_id, event.occurred_at_ms);
      return id;
    }).immediate();
  }

  endSession(id: string, atMs: number, quality = "observed"): void {
    assertTimestamp(atMs);
    this.db.transaction(() => this.endSessionInTransaction(id, atMs, quality)).immediate();
  }

  private endSessionInTransaction(id: string, atMs: number, quality: string): void {
    const ended = this.db
      .prepare(
        "UPDATE sessions SET ended_at_ms = ?, end_quality = ? WHERE id = ? AND ended_at_ms IS NULL AND started_at_ms <= ?",
      )
      .run(atMs, quality, id, atMs);
    if (!ended.changes) return;
    this.db.prepare("UPDATE platform_streams SET ended_at_ms=(SELECT ended_at_ms FROM sessions WHERE id=?) WHERE session_id=? AND ended_at_ms IS NULL").run(id, id);
    this.db
      .prepare(
        `DELETE FROM event_sessions WHERE session_id = ? AND event_id IN (SELECT id FROM effective_events WHERE occurred_at_ms >= ?)`,
      )
      .run(id, atMs);
  }

  deleteManualSession(id: string, atMs: number): void {
    assertTimestamp(atMs);
    this.db.transaction(()=>{
      const session=this.db.prepare("SELECT kind,started_at_ms FROM sessions WHERE id=?").get(id) as {kind:string;started_at_ms:number}|undefined;
      if(!session)throw new Error("SESSION_NOT_FOUND");
      if(session.kind!=="manual" || this.db.prepare("SELECT 1 FROM platform_streams WHERE session_id=?").get(id))throw new Error("PLATFORM_SESSION_MANAGED_AUTOMATICALLY");
      if(this.db.prepare("SELECT 1 FROM session_tombstones WHERE session_id=?").get(id))return;
      const events=this.db.prepare("SELECT e.id,e.source,e.account_id,e.occurred_at_ms FROM effective_events e JOIN event_sessions es ON es.event_id=e.id WHERE es.session_id=?").all(id) as {id:string;source:string;account_id:string;occurred_at_ms:number|null}[];
      this.endSessionInTransaction(id,Math.max(atMs,session.started_at_ms),"manual");
      this.db.prepare("INSERT INTO session_tombstones VALUES (?,?,?)").run(id,atMs,JSON.stringify(events.map(event=>event.id)));
      this.db.prepare("DELETE FROM event_sessions WHERE session_id=?").run(id);
      for(const event of events){
        if(event.occurred_at_ms===null)continue;
        const candidates=this.db.prepare(`SELECT DISTINCT ps.session_id FROM platform_streams ps JOIN sessions s ON s.id=ps.session_id
          WHERE s.kind='platform' AND ps.started_at_ms<=?
           AND (ps.ended_at_ms IS NULL OR ps.ended_at_ms>?) AND (s.ended_at_ms IS NULL OR s.ended_at_ms>?)
           AND (?='donationalerts' OR (ps.platform=? AND ps.account_id=?)) LIMIT 2`).all(event.occurred_at_ms,event.occurred_at_ms,event.occurred_at_ms,event.source,event.source,event.account_id) as {session_id:string}[];
        if(candidates.length===1)this.db.prepare("INSERT INTO event_sessions VALUES (?,?)").run(event.id,candidates[0]!.session_id);
      }
    }).immediate();
  }

  sessions(sessionId?: string): Record<string, unknown>[] {
    const rows = this.db
      .prepare(
        `SELECT s.*,
          (SELECT count(*) FROM event_sessions es WHERE es.session_id=s.id) AS event_count,
          (SELECT title FROM platform_streams p WHERE p.session_id=s.id AND trim(title)<>'' ORDER BY CASE platform WHEN 'twitch' THEN 0 ELSE 1 END,last_observed_at_ms DESC,account_id,external_id LIMIT 1) AS primaryTitle,
          (SELECT json_group_array(platform) FROM (SELECT DISTINCT platform FROM platform_streams p WHERE p.session_id=s.id ORDER BY platform)) AS platforms_json,
          (SELECT json_group_array(json_object('platform',platform,'url',url)) FROM (SELECT DISTINCT platform,url FROM platform_streams p WHERE p.session_id=s.id AND url IS NOT NULL ORDER BY platform,url)) AS urls_json
        FROM sessions s WHERE (? IS NULL OR s.id=?) AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=s.id) ORDER BY started_at_ms DESC,s.id DESC LIMIT 100`,
      )
      .all(sessionId??null,sessionId??null) as Record<string, unknown>[];
    const ids=JSON.stringify(rows.map(row=>row.id));
    const counts=this.db.prepare(`SELECT session_id,sum(n) AS n FROM (
      SELECT es.session_id,count(*) AS n FROM effective_events e JOIN event_sessions es ON es.event_id=e.id WHERE e.type='chat.message' AND es.session_id IN(SELECT value FROM json_each(?)) AND (json_extract(e.payload_json,'$.originChannelId') IS NULL OR json_extract(e.payload_json,'$.originChannelId')=e.account_id) GROUP BY es.session_id
      UNION ALL SELECT ps.session_id,count(DISTINCT m.account_id||':'||m.id) AS n FROM youtube_messages m JOIN platform_streams ps ON ps.platform='youtube' AND ps.account_id=m.account_id AND ps.started_at_ms<=m.published_at_ms AND (ps.ended_at_ms IS NULL OR ps.ended_at_ms>m.published_at_ms) WHERE ps.session_id IN(SELECT value FROM json_each(?)) AND json_extract(m.payload_json,'$.snippet.type') IN('textMessageEvent','superChatEvent','superStickerEvent') GROUP BY ps.session_id
    ) GROUP BY session_id`).all(ids,ids) as {session_id:string;n:number}[];
    const messagesBySession=new Map(counts.map(row=>[row.session_id,row.n]));
    const samples=this.db.prepare('SELECT session_id,observed_at_ms,twitch_viewers,youtube_viewers FROM stream_samples WHERE session_id IN(SELECT value FROM json_each(?)) ORDER BY observed_at_ms').all(ids) as {session_id:string;observed_at_ms:number;twitch_viewers:number|null;youtube_viewers:number|null}[];
    const platforms=this.db.prepare('SELECT session_id,platform,started_at_ms AS "from",coalesce(ended_at_ms,?) AS "to" FROM platform_streams WHERE session_id IN(SELECT value FROM json_each(?))').all(Date.now(),ids) as {session_id:string;platform:string;from:number;to:number}[];
    const tips=this.db.prepare("SELECT es.session_id,json_extract(e.payload_json,'$.currency') AS currency,json_extract(e.payload_json,'$.amountMinor') AS amount FROM effective_events e JOIN event_sessions es ON es.event_id=e.id WHERE e.type='donation' AND es.session_id IN(SELECT value FROM json_each(?))").all(ids) as {session_id:string;currency:string|null;amount:string|null}[];
    const group=<T extends {session_id:string}>(values:T[])=>{const groups=new Map<string,T[]>();for(const value of values){const list=groups.get(value.session_id)??[];list.push(value);groups.set(value.session_id,list);}return groups;};
    const samplesBySession=group(samples),platformsBySession=group(platforms),tipsBySession=group(tips);
    return rows.map(({platforms_json, urls_json, ...row}) => {
      const links=platformsBySession.get(String(row.id))??[];
      const windows=windowsFromLinks(links.map(p=>({started_at_ms:p.from,ended_at_ms:p.to})),Number(row.started_at_ms),Number(row.ended_at_ms??Date.now()));
      const merged=new Map<number,{observed_at_ms:number;twitch_viewers:number|null;youtube_viewers:number|null}>();
      for(const sample of samplesBySession.get(String(row.id))??[]){const at=Math.floor(sample.observed_at_ms/60000)*60000,value=merged.get(at)??{observed_at_ms:at,twitch_viewers:null,youtube_viewers:null};if(sample.twitch_viewers!==null)value.twitch_viewers=sample.twitch_viewers;if(sample.youtube_viewers!==null)value.youtube_viewers=sample.youtube_viewers;merged.set(at,value);}
      const viewers=streamMetrics(windows,[...merged.values()],new Map(),links).viewers.all;
      const donations:Record<string,string>={};let donationCount=0;
      for(const tip of tipsBySession.get(String(row.id))??[]){donationCount++;if(tip.currency&&tip.amount&&/^\d+$/.test(tip.amount))donations[tip.currency]=(BigInt(donations[tip.currency]??'0')+BigInt(tip.amount)).toString();}
      return ({
      ...row,messageCount:messagesBySession.get(String(row.id))??0, durationMs:windows.reduce((sum,w)=>sum+w.to-w.from,0),viewerMean:viewers.mean,viewerPeak:viewers.peak,donationTotals:donations,donationCount,
      breaks:sessionBreaks(windows),
      platforms: JSON.parse(platforms_json as string) as string[],
      confirmedUrls: (JSON.parse(urls_json as string) as {platform:"twitch"|"youtube";url:string}[])
        .filter(link=>this.validPlatformStreamUrl(link.platform,link.url)),
    });});
  }

  platformStreams(sessionId: string): Record<string, unknown>[] {
    return this.db.prepare(`
      SELECT * FROM platform_streams WHERE session_id=?
      ORDER BY platform,account_id,external_id
    `).all(sessionId) as Record<string, unknown>[];
  }

  platformMissing(platform: "twitch" | "youtube", accountId: string, presentIds: string[], observedAtMs: number): void {
    if (
      (platform !== "twitch" && platform !== "youtube") ||
      typeof accountId !== "string" || !accountId.trim() || accountId.length > 256 ||
      !Array.isArray(presentIds) || presentIds.length > 1000 ||
      presentIds.some(id => typeof id !== "string" || !id.trim() || id.length > 256) ||
      new Set(presentIds).size !== presentIds.length
    ) throw new Error("INVALID_PLATFORM_MISSING");
    assertTimestamp(observedAtMs);
    const present = new Set(presentIds);
    this.db.transaction(() => {
      const open = this.db.prepare(`
        SELECT external_id,session_id,started_at_ms,last_observed_at_ms,offline_checks,first_missing_at_ms
        FROM platform_streams WHERE platform=? AND account_id=? AND ended_at_ms IS NULL
      `).all(platform, accountId) as {external_id:string;session_id:string;started_at_ms:number;last_observed_at_ms:number;offline_checks:number;first_missing_at_ms:number|null}[];
      const affected = new Set<string>();
      for (const link of open) {
        if (present.has(link.external_id) || observedAtMs <= link.last_observed_at_ms) continue;
        const firstMissingAtMs = link.first_missing_at_ms ?? observedAtMs;
        const checks = link.offline_checks + 1;
        this.db.prepare(`
          UPDATE platform_streams SET last_observed_at_ms=?,offline_checks=?,first_missing_at_ms=?
          WHERE platform=? AND account_id=? AND external_id=? AND ended_at_ms IS NULL AND last_observed_at_ms<?
        `).run(observedAtMs, checks, firstMissingAtMs, platform, accountId, link.external_id, observedAtMs);
        if (checks >= 2) {
          this.db.prepare(`
            UPDATE platform_streams SET ended_at_ms=?
            WHERE platform=? AND account_id=? AND external_id=? AND ended_at_ms IS NULL
          `).run(firstMissingAtMs, platform, accountId, link.external_id);
          affected.add(link.session_id);
        }
      }
      for (const sessionId of affected) {
        const state = this.db.prepare(`
          SELECT MAX(ended_at_ms) AS ended_at_ms,
            SUM(CASE WHEN ended_at_ms IS NULL THEN 1 ELSE 0 END) AS open_links
          FROM platform_streams WHERE session_id=?
        `).get(sessionId) as {ended_at_ms:number|null;open_links:number};
        if (state.open_links === 0 && state.ended_at_ms !== null)
          this.endSessionInTransaction(sessionId, state.ended_at_ms, "estimated");
      }
    }).immediate();
  }

  attachPlatformStream(
    sessionId: string,
    platform: "twitch" | "youtube",
    accountId: string,
    externalId: string,
    startedAtMs: number,
    observedAtMs: number,
    url: string | null,
    title: string,
  ): void {
    if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 256)
      throw new Error("INVALID_PLATFORM_STREAM");
    this.validatePlatformStreamInput(platform, accountId, externalId, startedAtMs, observedAtMs, url, title);
    this.db.transaction(() => this.attachPlatformStreamInTransaction(sessionId, platform, accountId, externalId, startedAtMs, observedAtMs, url, title)).immediate();
  }

  observePlatformStream(
    platform: "twitch" | "youtube",
    accountId: string,
    externalId: string,
    startedAtMs: number,
    observedAtMs: number,
    url: string | null,
    title: string,
    confirmedPresentIds?: string[],
  ): string | null {
    this.validatePlatformStreamInput(platform, accountId, externalId, startedAtMs, observedAtMs, url, title);
    if (confirmedPresentIds !== undefined && (!Array.isArray(confirmedPresentIds) ||
      confirmedPresentIds.length > 1000 || new Set(confirmedPresentIds).size !== confirmedPresentIds.length ||
      !confirmedPresentIds.includes(externalId) ||
      confirmedPresentIds.some(id=>typeof id!=="string" || !id.trim() || id.length>256)))
      throw new Error("INVALID_PLATFORM_STREAM");
    return this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT session_id,ended_at_ms,last_observed_at_ms,first_missing_at_ms
        FROM platform_streams WHERE platform=? AND account_id=? AND external_id=?
      `).get(platform, accountId, externalId) as {session_id:string;ended_at_ms:number|null;last_observed_at_ms:number;first_missing_at_ms:number|null} | undefined;
      if (existing?.ended_at_ms !== null && existing !== undefined) return null;

      let sessionId = existing?.session_id;
      if (sessionId === undefined) {
        // YouTube supports concurrent broadcasts. A new ID alone cannot prove
        // another broadcast ended; only a complete confirmed set can do that.
        const confirmed = confirmedPresentIds ?? (platform === "twitch" ? [externalId] : undefined);
        if (confirmed && !this.supersedeProviderLinks(platform, accountId, externalId, observedAtMs, confirmed)) return null;
        const active = this.db.prepare(`
          SELECT s.id,s.started_at_ms FROM sessions s
          WHERE s.kind='platform' AND s.ended_at_ms IS NULL
            AND EXISTS (SELECT 1 FROM platform_streams p WHERE p.session_id=s.id AND p.ended_at_ms IS NULL)
          ORDER BY s.started_at_ms DESC,s.id DESC LIMIT 1
        `).get() as {id:string;started_at_ms:number} | undefined;
        if (startedAtMs <= observedAtMs && active && observedAtMs >= active.started_at_ms)
          sessionId = active.id;
        else {
          // Do not close or reuse an unrelated open session for this provider account.
          const occupied = this.db.prepare("SELECT 1 FROM sessions WHERE account_id=? AND ended_at_ms IS NULL LIMIT 1").get(accountId);
          const streamId = `${platform}:${externalId}`;
          const prior = this.db.prepare("SELECT 1 FROM sessions WHERE account_id=? AND stream_id=? LIMIT 1").get(accountId, streamId);
          if (occupied || prior) return null;
          const recent=this.db.prepare(`SELECT s.id FROM sessions s
            WHERE s.kind='platform' AND s.ended_at_ms IS NOT NULL
              AND s.ended_at_ms<=? AND s.ended_at_ms>?
              AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=s.id)
              AND EXISTS(SELECT 1 FROM platform_streams p WHERE p.session_id=s.id AND p.platform=? AND p.account_id=?)
            ORDER BY s.ended_at_ms DESC,s.id DESC LIMIT 1`).get(startedAtMs,startedAtMs-30*60000,platform,accountId) as {id:string}|undefined;
          if(recent){
            sessionId=recent.id;
            this.db.prepare("UPDATE sessions SET ended_at_ms=NULL,end_quality='unknown' WHERE id=?").run(sessionId);
          }else{
            sessionId = randomUUID();
            this.db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,NULL,'unknown')")
              .run(sessionId, accountId, streamId, "platform", startedAtMs, observedAtMs);
          }
        }
      }
      this.attachPlatformStreamInTransaction(sessionId, platform, accountId, externalId, startedAtMs, observedAtMs, url, title);
      this.backfillPlatformEvents(sessionId, observedAtMs);
      return sessionId;
    }).immediate();
  }

  private supersedeProviderLinks(
    platform: "twitch" | "youtube", accountId: string, externalId: string,
    observedAtMs: number,
    confirmedPresentIds: string[],
  ): boolean {
    const oldLinks = this.db.prepare(`
      SELECT external_id,session_id,started_at_ms,last_observed_at_ms,first_missing_at_ms
      FROM platform_streams
      WHERE platform=? AND account_id=? AND external_id<>? AND ended_at_ms IS NULL
        AND external_id NOT IN (SELECT value FROM json_each(?))
    `).all(platform, accountId, externalId, JSON.stringify(confirmedPresentIds)) as {external_id:string;session_id:string;started_at_ms:number;last_observed_at_ms:number;first_missing_at_ms:number|null}[];
    if (oldLinks.some(link => observedAtMs <= link.last_observed_at_ms)) return false;
    const affected = new Set<string>();
    for (const link of oldLinks) {
      // Do not invent continuous coverage across a collector outage. The old
      // stream end is estimated from its last observation / first missing poll.
      const endAtMs = Math.max(link.started_at_ms, link.first_missing_at_ms??link.last_observed_at_ms);
      this.db.prepare(`
        UPDATE platform_streams SET ended_at_ms=?
        WHERE platform=? AND account_id=? AND external_id=? AND ended_at_ms IS NULL
      `).run(endAtMs, platform, accountId, link.external_id);
      affected.add(link.session_id);
    }
    for (const oldSessionId of affected) {
      const state = this.db.prepare(`
        SELECT MAX(ended_at_ms) AS ended_at_ms,
          SUM(CASE WHEN ended_at_ms IS NULL THEN 1 ELSE 0 END) AS open_links
        FROM platform_streams WHERE session_id=?
      `).get(oldSessionId) as {ended_at_ms:number|null;open_links:number};
      if (state.open_links === 0 && state.ended_at_ms !== null)
        this.endSessionInTransaction(oldSessionId, state.ended_at_ms, "estimated");
    }
    return true;
  }

  private validatePlatformStreamInput(
    platform: "twitch" | "youtube", accountId: string, externalId: string,
    startedAtMs: number, observedAtMs: number, url: string | null, title: string,
  ): void {
    if (
      (platform !== "twitch" && platform !== "youtube") ||
      typeof accountId !== "string" || !accountId.trim() || accountId.length > 256 ||
      typeof externalId !== "string" || !externalId.trim() || externalId.length > 256 ||
      typeof title !== "string" || title.length > 1000 ||
      (url !== null && (typeof url !== "string" || url.length > 2048))
    ) throw new Error("INVALID_PLATFORM_STREAM");
    assertTimestamp(startedAtMs);
    assertTimestamp(observedAtMs);
    if (observedAtMs < startedAtMs || (url !== null && !this.validPlatformStreamUrl(platform, url)))
      throw new Error("INVALID_PLATFORM_STREAM");
  }

  private attachPlatformStreamInTransaction(
    sessionId: string, platform: "twitch" | "youtube", accountId: string,
    externalId: string, startedAtMs: number, observedAtMs: number, url: string | null, title: string,
  ): void {
    const existing = this.db.prepare(`
      SELECT session_id,ended_at_ms,last_observed_at_ms,first_missing_at_ms
      FROM platform_streams WHERE platform=? AND account_id=? AND external_id=?
    `).get(platform, accountId, externalId) as {session_id:string;ended_at_ms:number|null;last_observed_at_ms:number;first_missing_at_ms:number|null} | undefined;
    if (existing && (existing.session_id !== sessionId || existing.ended_at_ms !== null))
      throw new Error("PLATFORM_STREAM_CONFLICT");
    const session = this.db.prepare("SELECT kind,ended_at_ms FROM sessions WHERE id=?")
      .get(sessionId) as {kind:string;ended_at_ms:number|null} | undefined;
    if (!session || session.kind !== "platform" || session.ended_at_ms !== null)
      throw new Error(existing ? "PLATFORM_STREAM_CONFLICT" : "PLATFORM_STREAM_SESSION");
    if (existing) {
      if (observedAtMs < existing.last_observed_at_ms ||
        (existing.first_missing_at_ms !== null && observedAtMs < existing.first_missing_at_ms)) return;
      this.db.prepare(`
        UPDATE platform_streams SET
          last_observed_at_ms=MAX(last_observed_at_ms,?),
          offline_checks=0,first_missing_at_ms=NULL,
          url=CASE WHEN ?>=last_observed_at_ms THEN ? ELSE url END,
          title=CASE WHEN ?>=last_observed_at_ms THEN ? ELSE title END
        WHERE platform=? AND account_id=? AND external_id=?
      `).run(observedAtMs, observedAtMs, url, observedAtMs, title, platform, accountId, externalId);
    } else {
      this.db.prepare(`
        INSERT INTO platform_streams
          (platform,account_id,external_id,session_id,started_at_ms,last_observed_at_ms,url,title)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(platform, accountId, externalId, sessionId, startedAtMs, observedAtMs, url, title);
    }
    this.db.prepare(`
      UPDATE sessions SET started_at_ms=MIN(started_at_ms,(
        SELECT MIN(started_at_ms) FROM platform_streams WHERE session_id=?
      )) WHERE id=?
    `).run(sessionId, sessionId);
  }

  private backfillPlatformEvents(sessionId: string, observedAtMs: number): void {
    // Events already assigned to a manual or other session are never stolen.
    // This schema currently has Twitch and donation-alert events; YouTube chat is stored separately.
    this.db.prepare(`
      INSERT OR IGNORE INTO event_sessions(event_id,session_id)
      SELECT e.id,? FROM effective_events e JOIN sessions s ON s.id=?
      WHERE e.occurred_at_ms IS NOT NULL
        AND e.occurred_at_ms>=CASE WHEN e.source='donationalerts' THEN s.started_at_ms ELSE s.recording_started_at_ms END AND e.occurred_at_ms<=?
        AND ((e.source='twitch' AND EXISTS (
          SELECT 1 FROM platform_streams ps WHERE ps.session_id=s.id
            AND ps.platform='twitch' AND ps.account_id=e.account_id
        )) OR e.source='donationalerts')
        AND NOT EXISTS (SELECT 1 FROM event_sessions es WHERE es.event_id=e.id)
        AND NOT EXISTS (
          SELECT 1 FROM sessions m WHERE m.kind='manual' AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=m.id) AND m.started_at_ms<=e.occurred_at_ms
            AND (m.ended_at_ms IS NULL OR m.ended_at_ms>e.occurred_at_ms)
        )
    `).run(sessionId, sessionId, observedAtMs);
    // EventSub can arrive before Helix discovers the stream. Category facts
    // may precede recording coverage, but must belong to a confirmed Twitch
    // broadcast. Do not fabricate viewers or take events from another session.
    this.db.prepare(`
      INSERT INTO stream_samples(session_id,observed_at_ms,category_id,category_name,title,twitch_viewers,youtube_viewers)
      SELECT ?,e.occurred_at_ms,json_extract(e.payload_json,'$.categoryId'),
        json_extract(e.payload_json,'$.categoryName'),json_extract(e.payload_json,'$.title'),NULL,NULL
      FROM platform_streams ps JOIN events e ON e.account_id=ps.account_id
        AND e.source='twitch' AND e.type='channel.update'
      WHERE ps.session_id=? AND ps.platform='twitch' AND e.occurred_at_ms<=?
        AND e.occurred_at_ms>=ps.started_at_ms
        AND (ps.ended_at_ms IS NULL OR e.occurred_at_ms<ps.ended_at_ms)
        AND NOT EXISTS (SELECT 1 FROM event_sessions es WHERE es.event_id=e.id AND es.session_id<>?)
        AND json_type(e.payload_json,'$.categoryId')='text'
        AND json_type(e.payload_json,'$.categoryName')='text'
        AND json_type(e.payload_json,'$.title')='text'
        AND length(json_extract(e.payload_json,'$.categoryId'))<=1000
        AND length(json_extract(e.payload_json,'$.categoryName'))<=1000
        AND length(json_extract(e.payload_json,'$.title'))<=1000
      ORDER BY e.occurred_at_ms,e.received_at_ms,e.id
      ON CONFLICT(session_id,observed_at_ms) DO UPDATE SET
        category_id=excluded.category_id,category_name=excluded.category_name,title=excluded.title
    `).run(sessionId,sessionId,observedAtMs,sessionId);
  }

  private validPlatformStreamUrl(platform: "twitch" | "youtube", value: string): boolean {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
      if (platform === "youtube")
        return (url.hostname === "youtube.com" || url.hostname === "www.youtube.com") &&
          url.pathname === "/watch" && Boolean(url.searchParams.get("v"));
      return (url.hostname === "twitch.tv" || url.hostname === "www.twitch.tv") &&
        /^\/[A-Za-z0-9_]+(?:\/.*)?$/.test(url.pathname);
    } catch { return false; }
  }

  activeLogicalStream(): Record<string, unknown> | null {
    return (this.db.prepare(`
      SELECT s.* FROM sessions s
      WHERE s.kind='platform' AND s.ended_at_ms IS NULL
        AND EXISTS (
          SELECT 1 FROM platform_streams p
          WHERE p.session_id=s.id AND p.ended_at_ms IS NULL
        )
      ORDER BY s.started_at_ms DESC,s.id DESC LIMIT 1
    `).get() as Record<string, unknown> | undefined) ?? null;
  }

}
