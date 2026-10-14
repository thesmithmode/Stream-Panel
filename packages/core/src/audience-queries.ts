import type Database from "better-sqlite3";
import {assertTimestamp,candidateKey} from "./domain.js";
import {botExclusionSet} from "./bots.js";
import {unionSpans} from "./analytics.js";
import {donorRanking} from "./donation-statistics.js";
import {sessionWindows,windowsFromLinks} from "./session-windows.js";
import {presenceMinutes,pollCoveredMinutes,type PresencePoll} from "./presence.js";

/** Read model for audience/history; never owns collectors or mutations. */
export class AudienceQueries {
  constructor(private readonly db:Database.Database) {}

  persons(
    search = "",
    excludedBotLogins: readonly string[] = [],
    fromMs=0,
  ): Record<string, unknown>[] {
    if(!Number.isSafeInteger(fromMs)||fromMs<0)throw new Error("INVALID_PERIOD");
    const excluded = this.analyticsExclusions(excludedBotLogins);
    const botJson = JSON.stringify([...excluded]);
    const term = search;
    const key = candidateKey(search);
    // Aggregate counts via JOIN instead of correlated per-row event scans.
    return this.db
      .prepare(
        `SELECT p.id, p.display_name, p.revision,
          coalesce(ec.event_count, 0) + (SELECT count(*) FROM youtube_messages m JOIN youtube_identities y ON y.account_id=m.account_id AND y.external_id=m.author_id WHERE y.person_id=p.id AND m.published_at_ms>=${fromMs}) AS event_count,
          (SELECT group_concat(DISTINCT source) FROM (SELECT source FROM identities WHERE person_id=p.id UNION ALL SELECT 'youtube' AS source FROM youtube_identities WHERE person_id=p.id)) AS sources,
          CASE WHEN EXISTS(
            SELECT 1 FROM identities ib
            WHERE ib.person_id=p.id AND ib.match_key IN (SELECT value FROM json_each(?))
          ) OR EXISTS(SELECT 1 FROM youtube_identities y LEFT JOIN youtube_identity_aliases a ON a.identity_id=y.id WHERE y.person_id=p.id AND (y.is_owner=1 OR y.external_id=y.account_id OR y.match_key IN(SELECT value FROM json_each(?)) OR a.match_key IN(SELECT value FROM json_each(?)))) THEN 1 ELSE 0 END AS is_bot
        FROM persons p
        LEFT JOIN (
          SELECT i.person_id, count(e.id) AS event_count
          FROM identities i
          LEFT JOIN effective_events e ON e.identity_id = i.id AND coalesce(e.occurred_at_ms,e.received_at_ms)>=${fromMs}
          GROUP BY i.person_id
        ) ec ON ec.person_id = p.id
        WHERE (EXISTS(SELECT 1 FROM identities i WHERE i.person_id=p.id) OR EXISTS(SELECT 1 FROM youtube_identities y WHERE y.person_id=p.id) OR (NOT EXISTS(SELECT 1 FROM person_merges m WHERE m.source_person_id=p.id AND m.undone_at_ms IS NULL) AND (EXISTS(SELECT 1 FROM person_notes n WHERE n.person_id=p.id) OR EXISTS(SELECT 1 FROM person_tags t WHERE t.person_id=p.id) OR EXISTS(SELECT 1 FROM person_preferences pref WHERE pref.person_id=p.id))))
          AND (
            ? = '' OR instr(lower(p.display_name), lower(?)) > 0
            OR EXISTS(
              SELECT 1 FROM identities i
              LEFT JOIN identity_aliases a ON a.identity_id=i.id
              WHERE i.person_id=p.id AND instr(a.candidate_key, ?) > 0
            ) OR EXISTS(SELECT 1 FROM youtube_identities y JOIN youtube_identity_aliases a ON a.identity_id=y.id WHERE y.person_id=p.id AND instr(a.match_key,?)>0)
          )
          AND (${fromMs}=0 OR coalesce(ec.event_count,0)>0 OR EXISTS(SELECT 1 FROM youtube_messages m JOIN youtube_identities y ON y.account_id=m.account_id AND y.external_id=m.author_id WHERE y.person_id=p.id AND m.published_at_ms>=${fromMs}) OR EXISTS(SELECT 1 FROM presence_members m JOIN presence_polls poll ON poll.id=m.poll_id JOIN identities i ON i.id=m.identity_id WHERE i.person_id=p.id AND poll.status='complete' AND poll.completed_at_ms>=${fromMs}))
        ORDER BY event_count DESC, p.display_name
        LIMIT 500`,
      )
      .all(botJson, botJson, botJson, term, term, key, key) as Record<string, unknown>[];
  }

  person(id: string,includeEvents=true): Record<string, unknown> {
    const row = this.db.prepare("SELECT * FROM persons WHERE id=?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error("PERSON_NOT_FOUND");
    return {
      ...row,
      identities: this.db
        .prepare("SELECT * FROM identities WHERE person_id=? UNION ALL SELECT id,'youtube' AS source,account_id,external_id,display_name,match_key AS candidate_key,person_id,match_key FROM youtube_identities WHERE person_id=?")
        .all(id,id),
      aliases: this.db
        .prepare(
          "SELECT a.* FROM identity_aliases a JOIN identities i ON i.id=a.identity_id WHERE i.person_id=? UNION ALL SELECT a.identity_id,a.name,a.match_key AS candidate_key,a.first_seen_ms,a.last_seen_ms FROM youtube_identity_aliases a JOIN youtube_identities y ON y.id=a.identity_id WHERE y.person_id=?",
        )
        .all(id,id),
      events: includeEvents?this.events(undefined, id):[],
    };
  }

  events(
    sessionId?: string,
    personId?: string,
    fromMs?: number,
    toMs?: number,
    type?:string,
    source?:string,
  ): Record<string, unknown>[] {
    if(source!==undefined&&!['all','twitch','youtube','donationalerts'].includes(source))throw new Error('INVALID_EVENT_SOURCE');
    if (fromMs !== undefined) assertTimestamp(fromMs);
    if (toMs !== undefined) assertTimestamp(toMs);
    if (fromMs !== undefined && toMs !== undefined && toMs <= fromMs)
      throw new Error("INVALID_EVENT_WINDOW");
    const events: Record<string,unknown>[] = source==='youtube'?[]:this.db
      .prepare(
        `SELECT e.*, i.display_name, i.person_id FROM effective_events e LEFT JOIN identities i ON i.id=e.identity_id
      WHERE (? IS NULL OR e.id IN (SELECT event_id FROM event_sessions WHERE session_id=?)) AND (? IS NULL OR i.person_id=?)
      AND (? IS NULL OR e.occurred_at_ms>=?) AND (? IS NULL OR e.occurred_at_ms<?) AND (? IS NULL OR e.type=?) AND (? IS NULL OR e.source=?)
      ORDER BY coalesce(e.occurred_at_ms,e.received_at_ms) DESC, e.id DESC LIMIT 200`,
      )
      .all(
        sessionId ?? null,
        sessionId ?? null,
        personId ?? null,
        personId ?? null,
        fromMs ?? null,
        fromMs ?? null,
        toMs ?? null,
        toMs ?? null,
        type??null,type??null,
        source&&source!=='all'?source:null,source&&source!=='all'?source:null,
      )
      .map((value) => {
        const row = value as Record<string, unknown>;
        return {
          ...row,
          payload: JSON.parse(String(row.payload_json)),
          payload_json: undefined,
        };
      });
    const yt = (source&&source!=='all'&&source!=='youtube')||(type&&type!=='chat.message')?[]:this.db.prepare(`SELECT m.*,y.person_id,y.display_name,
      (SELECT s.id FROM sessions s JOIN platform_streams ps ON ps.session_id=s.id
       WHERE ps.platform='youtube' AND ps.account_id=m.account_id
       AND m.published_at_ms>=ps.started_at_ms AND (ps.ended_at_ms IS NULL OR m.published_at_ms<ps.ended_at_ms)
       ORDER BY s.started_at_ms DESC LIMIT 1) AS session_id
      FROM youtube_messages m JOIN youtube_identities y ON y.account_id=m.account_id AND y.external_id=m.author_id
      WHERE (? IS NULL OR y.person_id=?) AND (? IS NULL OR m.published_at_ms>=?) AND (? IS NULL OR m.published_at_ms<?)
      AND json_extract(m.payload_json,'$.snippet.type') IN('textMessageEvent','superChatEvent','superStickerEvent')
      AND (? IS NULL OR session_id=?)
      ORDER BY m.published_at_ms DESC,m.id DESC LIMIT 200`).all(personId??null,personId??null,fromMs??null,fromMs??null,toMs??null,toMs??null,sessionId??null,sessionId??null) as any[];
    return [...events,...yt.filter(row=>!sessionId||row.session_id===sessionId).map(row=>({
      id:`youtube:${row.account_id}:${row.id}`,type:'chat.message',source:'youtube',account_id:row.account_id,
      display_name:row.display_name,person_id:row.person_id,session_id:row.session_id,occurred_at_ms:row.published_at_ms,received_at_ms:row.published_at_ms,
      time_quality:'provider',payload:{text:JSON.parse(row.payload_json).snippet.displayMessage??'',originChannelId:row.account_id},
    }))].sort((a,b)=>Number(b.occurred_at_ms??b.received_at_ms)-Number(a.occurred_at_ms??a.received_at_ms)||String(b.id).localeCompare(String(a.id))).slice(0,200);
  }

  summary(
    sessionId?: string,
    excludedBotLogins: readonly string[] = [],
    details = true,
  ): Record<string, unknown> {
    const excluded = this.analyticsExclusions(excludedBotLogins);
    const botKeys = [...excluded];
    const botJson = JSON.stringify(botKeys);
    const sid = sessionId ?? null;
    const scope = sessionId ? [sessionId] : [];
    const inSession = sessionId
      ? "e.id IN (SELECT event_id FROM event_sessions WHERE session_id=?)"
      : "1";
    // SQL aggregates — avoid loading/parsing every event row in JS.
    const counts = this.db
      .prepare(
        `SELECT
        (SELECT count(*) FROM effective_events e WHERE ${inSession}) AS event_count,
        (SELECT count(*) FROM effective_events e
          LEFT JOIN identities i ON i.id = e.identity_id
          WHERE ${inSession}
          AND e.type = 'chat.message'
          AND (
            json_extract(e.payload_json, '$.originChannelId') IS NULL
            OR json_extract(e.payload_json, '$.originChannelId') = e.account_id
          )
          AND (
            i.id IS NULL
            OR i.match_key NOT IN (SELECT value FROM json_each(?))
          )
        ) AS messages,
        (SELECT count(*) FROM effective_events e LEFT JOIN identities i ON i.id=e.identity_id WHERE ${inSession} AND e.type = 'donation' AND (i.id IS NULL OR i.match_key NOT IN(SELECT value FROM json_each(?)))) AS donations`,
      )
      .get(...scope, ...scope, botJson, ...scope, botJson) as {
      event_count: number;
      messages: number;
      donations: number;
    };
    const youtubeParticipants=this.db.prepare(`SELECT y.person_id,y.display_name,count(*) AS messages
      FROM youtube_messages m JOIN youtube_identities y ON y.account_id=m.account_id AND y.external_id=m.author_id
      WHERE json_extract(m.payload_json,'$.snippet.type') IN('textMessageEvent','superChatEvent','superStickerEvent')
        AND y.is_owner=0 AND y.external_id<>y.account_id AND y.match_key NOT IN(SELECT value FROM json_each(?))
        AND (? IS NULL OR EXISTS(SELECT 1 FROM platform_streams ps WHERE ps.session_id=? AND ps.platform='youtube' AND ps.account_id=m.account_id AND m.published_at_ms>=ps.started_at_ms AND (ps.ended_at_ms IS NULL OR m.published_at_ms<ps.ended_at_ms)))
      GROUP BY y.person_id`).all(botJson,sid,sid) as {person_id:string;display_name:string;messages:number}[];
    const youtubeMessageCount=youtubeParticipants.reduce((sum,row)=>sum+row.messages,0);
    const donationRows = this.db
      .prepare(
        `SELECT json_extract(e.payload_json, '$.currency') AS currency,
                json_extract(e.payload_json, '$.amountMinor') AS amount_minor
         FROM effective_events e LEFT JOIN identities i ON i.id=e.identity_id
         WHERE ${inSession} AND e.type = 'donation' AND (i.id IS NULL OR i.match_key NOT IN(SELECT value FROM json_each(?)))
           AND json_extract(e.payload_json, '$.currency') IS NOT NULL
           AND json_extract(e.payload_json, '$.amountMinor') IS NOT NULL`,
      )
      .all(...scope, botJson) as { currency: string; amount_minor: string }[];
    const totals: Record<string, string> = {};
    for (const row of donationRows) {
      totals[row.currency] = (
        BigInt(totals[row.currency] ?? "0") + BigInt(row.amount_minor)
      ).toString();
    }
    // Stream cards do not need a second expansion of minute presence data.
    if(!details)return {messages:counts.messages+youtubeMessageCount,donations:counts.donations,totals,chatters:null,lastPollAtMs:null,events:counts.event_count+youtubeMessageCount};
    const participants=this.db.prepare(`SELECT i.person_id,i.display_name,count(*) AS messages FROM effective_events e JOIN identities i ON i.id=e.identity_id
      WHERE ${inSession} AND e.type='chat.message' AND i.match_key NOT IN(SELECT value FROM json_each(?))
        AND (json_extract(e.payload_json,'$.originChannelId') IS NULL OR json_extract(e.payload_json,'$.originChannelId')=e.account_id)
      GROUP BY i.person_id`).all(...scope,botJson) as {person_id:string;display_name:string;messages:number}[];
    const combinedParticipants=new Map(participants.map(row=>[row.person_id,{personId:row.person_id,name:row.display_name,messages:row.messages}]));
    for(const row of youtubeParticipants){const previous=combinedParticipants.get(row.person_id);if(previous)previous.messages+=row.messages;else combinedParticipants.set(row.person_id,{personId:row.person_id,name:row.display_name,messages:row.messages});}
    const latest = this.db
      .prepare(
        `SELECT p.id, p.completed_at_ms FROM presence_polls p
         WHERE p.status='complete' AND (? IS NULL OR p.session_id=?)
         ORDER BY p.completed_at_ms DESC LIMIT 1`,
      )
      .get(sid, sid) as { id: string; completed_at_ms: number } | undefined;
    let chatters: number | null = null;
    if (latest) {
      chatters = (
        this.db
          .prepare(
            `SELECT count(*) n FROM presence_members m
             JOIN identities i ON i.id = m.identity_id
             WHERE m.poll_id = ?
               AND i.match_key NOT IN (SELECT value FROM json_each(?))`,
          )
          .get(latest.id, botJson) as { n: number }
      ).n;
    }
    const unique = this.db
      .prepare(
        `SELECT
          (SELECT count(DISTINCT i.person_id) FROM effective_events e
            JOIN identities i ON i.id = e.identity_id
            WHERE ${inSession}
              AND i.match_key NOT IN (SELECT value FROM json_each(?))
          ) AS unique_persons_events,
          (SELECT count(DISTINCT i.id) FROM effective_events e
            JOIN identities i ON i.id = e.identity_id
            WHERE ${inSession}
              AND i.match_key NOT IN (SELECT value FROM json_each(?))
          ) AS unique_identities_events`,
      )
      .get(...scope, botJson, ...scope, botJson) as {
      unique_persons_events: number;
      unique_identities_events: number;
    };
    let uniquePersonsObserved: number | null = null;
    let uniqueIdentitiesObserved: number | null = null;
    let coverage: {
      knownMinutes: number;
      totalMinutes: number;
      ratio: number | null;
    } | null = null;
    let messagesPerMinuteOfSession: number | null = null;
    let sessionDurationMs: number | null = null;
    let chattersOverTime: { atMs: number; chatters: number }[] = [];
    let gapCount = 0;
    if (sessionId) {
      const session = this.db
        .prepare("SELECT started_at_ms, ended_at_ms FROM sessions WHERE id=?")
        .get(sessionId) as
        | { started_at_ms: number; ended_at_ms: number | null }
        | undefined;
      if (session) {
        const fromMs = Math.floor(session.started_at_ms / 60_000) * 60_000;
        const endMs = session.ended_at_ms ?? Date.now();
        const toMs = Math.ceil(endMs / 60_000) * 60_000;
        sessionDurationMs = sessionWindows(this.db,sessionId,session.started_at_ms,endMs).reduce((sum,span)=>sum+span.to-span.from,0);
        const durationMin = sessionDurationMs / 60_000;
        messagesPerMinuteOfSession =
          durationMin > 0
            ? Math.round(((counts.messages + youtubeMessageCount) / durationMin) * 1000) / 1000
            : null;
        const cov = this.sessionCoverage(sessionId, fromMs, toMs);
        coverage = cov;
        uniquePersonsObserved = (
          this.db
            .prepare(
              `SELECT count(DISTINCT i.person_id) AS n
               FROM presence_members m
               JOIN presence_polls p ON p.id = m.poll_id
               JOIN identities i ON i.id = m.identity_id
               WHERE p.session_id = ? AND p.status = 'complete'
                 AND i.match_key NOT IN (SELECT value FROM json_each(?))`,
            )
            .get(sessionId, botJson) as { n: number }
        ).n;
        uniqueIdentitiesObserved = (
          this.db
            .prepare(
              `SELECT count(DISTINCT i.id) AS n
               FROM presence_members m
               JOIN presence_polls p ON p.id = m.poll_id
               JOIN identities i ON i.id = m.identity_id
               WHERE p.session_id = ? AND p.status = 'complete'
                 AND i.match_key NOT IN (SELECT value FROM json_each(?))`,
            )
            .get(sessionId, botJson) as { n: number }
        ).n;
        const pollRows = this.db
          .prepare(
            `SELECT p.id, p.completed_at_ms FROM presence_polls p
             WHERE p.session_id = ? AND p.status = 'complete'
             ORDER BY p.completed_at_ms ASC`,
          )
          .all(sessionId) as { id: string; completed_at_ms: number }[];
        const chatterStmt = this.db.prepare(
          `SELECT count(*) AS n FROM presence_members m
           JOIN identities i ON i.id = m.identity_id
           WHERE m.poll_id = ?
             AND i.match_key NOT IN (SELECT value FROM json_each(?))`,
        );
        chattersOverTime = pollRows.map((row) => ({
          atMs: row.completed_at_ms,
          chatters: (chatterStmt.get(row.id, botJson) as { n: number }).n,
        }));
        gapCount = (
          this.db
            .prepare(
              `SELECT count(*) AS n FROM collection_gaps g
               WHERE g.started_at_ms < ?
                 AND (g.ended_at_ms IS NULL OR g.ended_at_ms > ?)`,
            )
            .get(toMs, session.started_at_ms) as { n: number }
        ).n;
      }
    } else {
      gapCount = (
        this.db.prepare("SELECT count(*) AS n FROM collection_gaps").get() as {
          n: number;
        }
      ).n;
    }
    const uniquePeople=new Set((this.db.prepare(`SELECT DISTINCT i.person_id FROM effective_events e JOIN identities i ON i.id=e.identity_id WHERE ${inSession} AND i.match_key NOT IN(SELECT value FROM json_each(?))`).all(...scope,botJson) as {person_id:string}[]).map(row=>row.person_id));
    for(const row of youtubeParticipants)uniquePeople.add(row.person_id);
    return {
      messages: counts.messages + youtubeMessageCount,
      participants:[...combinedParticipants.values()].sort((a,b)=>b.messages-a.messages||a.name.localeCompare(b.name)),
      donations: counts.donations,
      totals,
      chatters,
      lastPollAtMs: latest?.completed_at_ms ?? null,
      events: counts.event_count + youtubeMessageCount,
      excludedBots: botKeys.length,
      uniquePersons: uniquePeople.size,
      uniqueIdentities: unique.unique_identities_events,
      uniquePersonsObserved,
      uniqueIdentitiesObserved,
      messagesPerMinuteOfSession,
      sessionDurationMs,
      coverage,
      chattersOverTime,
      gapCount,
    };
  }

  grid(
    sessionId: string,
    personId: string,
    fromMs: number,
    toMs: number,
  ): ReturnType<typeof presenceMinutes> {
    // Overlap query: a poll window may start before fromMs when covering
    // the interval from the previous successful sample.
    const polls = this.db
      .prepare(
        `SELECT p.* FROM presence_polls p WHERE session_id=? AND started_at_ms < ? AND completed_at_ms >= ? ORDER BY completed_at_ms`,
      )
      .all(sessionId, toMs, fromMs) as {
      id: string;
      started_at_ms: number;
      completed_at_ms: number;
      status: PresencePoll["status"];
    }[];
    // One indexed membership query for the whole interval; avoid a query per minute.
    const observed = new Set(
      (
        this.db
          .prepare(
            `SELECT m.poll_id FROM identities i
      CROSS JOIN presence_members m INDEXED BY presence_members_identity
      CROSS JOIN presence_polls p
      WHERE i.person_id=? AND m.identity_id=i.id AND p.id=m.poll_id
      AND p.session_id=? AND p.started_at_ms<? AND p.completed_at_ms>=?`,
          )
          .all(personId, sessionId, toMs, fromMs) as { poll_id: string }[]
      ).map((row) => row.poll_id),
    );
    const normalized = polls.map((poll) => ({
      startedAtMs: poll.started_at_ms,
      completedAtMs: poll.completed_at_ms,
      status: poll.status,
      userIds: observed.has(poll.id) ? [personId] : [],
    }));
    const windows=sessionWindows(this.db,sessionId,fromMs,toMs);
    return presenceMinutes(normalized, personId, fromMs, toMs).map(row=>windows.some(span=>row.minuteStartMs<span.to&&row.minuteStartMs+60000>span.from)?row:{...row,state:'break' as const});
  }


  /** Lower bound for clear / clear-user: open session start, else 6h window. */
  sessionRow(sessionId: string): {
    started_at_ms: number;
    ended_at_ms: number | null;
  } {
    const row = this.db
      .prepare("SELECT started_at_ms, ended_at_ms FROM sessions WHERE id=?")
      .get(sessionId) as
      | { started_at_ms: number; ended_at_ms: number | null }
      | undefined;
    if (!row) throw new Error("SESSION_NOT_FOUND");
    return row;
  }

  private sessionMinuteWindow(
    sessionId: string,
    nowMs = Date.now(),
  ): { fromMs: number; toMs: number; startedAtMs: number; endedAtMs: number | null } {
    const session = this.sessionRow(sessionId);
    const fromMs = Math.floor(session.started_at_ms / 60_000) * 60_000;
    const endMs = session.ended_at_ms ?? nowMs;
    let toMs = Math.ceil(endMs / 60_000) * 60_000;
    if (toMs < fromMs) toMs = fromMs;
    if (toMs - fromMs > 31 * 86_400_000) toMs = fromMs + 31 * 86_400_000;
    return {
      fromMs,
      toMs,
      startedAtMs: session.started_at_ms,
      endedAtMs: session.ended_at_ms,
    };
  }

  private sessionCoverage(
    sessionId: string,
    fromMs: number,
    toMs: number,
  ): { knownMinutes: number; totalMinutes: number; ratio: number | null } {
    const windows=sessionWindows(this.db,sessionId,fromMs,toMs);
    const liveMinute=(at:number)=>windows.some(span=>at<span.to&&at+60000>span.from);
    const totalMinutes=windows.reduce((sum,span)=>sum+span.to-span.from,0)/60000;
    const polls = this.db
      .prepare(
        `SELECT started_at_ms, completed_at_ms FROM presence_polls
         WHERE session_id=? AND status='complete'
           AND started_at_ms < ? AND completed_at_ms >= ?`,
      )
      .all(sessionId, toMs, fromMs) as {
      started_at_ms: number;
      completed_at_ms: number;
    }[];
    const known = new Set<number>();
    for (const poll of polls)
      for (const minute of pollCoveredMinutes(
        poll.started_at_ms,
        poll.completed_at_ms,
        fromMs,
        toMs,
      ))
        if(liveMinute(minute))known.add(minute);
    const knownMinutes=[...known].reduce((sum,at)=>sum+windows.reduce((n,span)=>n+Math.max(0,Math.min(at+60000,span.to)-Math.max(at,span.from)),0),0)/60000;
    return {
      knownMinutes,
      totalMinutes,
      ratio: totalMinutes > 0 ? Math.round((knownMinutes / totalMinutes) * 1000) / 1000 : null,
    };
  }

  private observedMinutesForPerson(
    sessionId: string,
    personId: string,
    fromMs: number,
    toMs: number,
  ): { observedMinutes: number; firstObservedMs: number | null; lastObservedMs: number | null } {
    const polls = this.db
      .prepare(
        `SELECT p.started_at_ms, p.completed_at_ms FROM presence_polls p
         WHERE p.session_id=? AND p.status='complete'
           AND p.started_at_ms < ? AND p.completed_at_ms >= ?
           AND EXISTS (
             SELECT 1 FROM presence_members m
             JOIN identities i ON i.id = m.identity_id
             WHERE m.poll_id = p.id AND i.person_id = ?
           )`,
      )
      .all(sessionId, toMs, fromMs, personId) as {
      started_at_ms: number;
      completed_at_ms: number;
    }[];
    const windows=sessionWindows(this.db,sessionId,fromMs,toMs);
    const observed = new Set<number>();
    for (const poll of polls)
      for (const minute of pollCoveredMinutes(
        poll.started_at_ms,
        poll.completed_at_ms,
        fromMs,
        toMs,
      ))
        if(windows.some(span=>minute<span.to&&minute+60000>span.from))observed.add(minute);
    let firstObservedMs: number | null = null;
    let lastObservedMs: number | null = null;
    for (const minute of observed) {
      if (firstObservedMs === null || minute < firstObservedMs)
        firstObservedMs = minute;
      if (lastObservedMs === null || minute > lastObservedMs)
        lastObservedMs = minute;
    }
    return { observedMinutes: observed.size, firstObservedMs, lastObservedMs };
  }

  /** Load presence once, then union minute buckets in memory. Query count is independent of people/streams. */
  private batchObserved(personIds?:readonly string[],sessionId?:string,beforeMs?:number,fromMs=0) {
    const now=Date.now(),ids=personIds?JSON.stringify(personIds):null;
    const polls=this.db.prepare(`SELECT DISTINCT i.person_id,p.session_id,p.started_at_ms,p.completed_at_ms,s.started_at_ms AS stream_start,s.ended_at_ms AS stream_end
      FROM presence_polls p JOIN presence_members m ON m.poll_id=p.id JOIN identities i ON i.id=m.identity_id JOIN sessions s ON s.id=p.session_id
      WHERE p.status='complete' AND p.completed_at_ms>=${fromMs} AND (? IS NOT NULL OR s.kind='platform') AND (? IS NULL OR i.person_id IN(SELECT value FROM json_each(?))) AND (? IS NULL OR p.session_id=?)`).all(sessionId??null,ids,ids,sessionId??null,sessionId??null) as {person_id:string;session_id:string;started_at_ms:number;completed_at_ms:number;stream_start:number;stream_end:number|null}[];
    const links=this.db.prepare('SELECT session_id,started_at_ms,ended_at_ms FROM platform_streams WHERE (? IS NULL OR session_id=?)').all(sessionId??null,sessionId??null) as {session_id:string;started_at_ms:number;ended_at_ms:number|null}[];
    const bySession=new Map<string,typeof links>();for(const link of links){const rows=bySession.get(link.session_id)??[];rows.push(link);bySession.set(link.session_id,rows);}
    const windows=new Map<string,{fromMs:number;toMs:number;spans:{from:number;to:number}[]}>();
    const result=new Map<string,Map<string,{minutes:Set<number>;first:number|null;last:number|null;startedAt:number}>>();
    for(const poll of polls){
      let w=windows.get(poll.session_id);
      if(!w){const rangeStart=Math.max(fromMs,Math.floor(poll.stream_start/60000)*60000),toMs=Math.min(Math.ceil((poll.stream_end??now)/60000)*60000,beforeMs??Infinity);w={fromMs:rangeStart,toMs,spans:windowsFromLinks(bySession.get(poll.session_id)??[],rangeStart,toMs)};windows.set(poll.session_id,w);}
      if(w.toMs<=w.fromMs||w.toMs-w.fromMs>31*86400000)continue;
      const person=result.get(poll.person_id)??new Map();result.set(poll.person_id,person);
      const observation=person.get(poll.session_id)??{minutes:new Set<number>(),first:null,last:null,startedAt:poll.stream_start};person.set(poll.session_id,observation);
      for(const minute of pollCoveredMinutes(poll.started_at_ms,poll.completed_at_ms,w.fromMs,w.toMs))if(w.spans.some(span=>minute<span.to&&minute+60000>span.from)){
        observation.minutes.add(minute);observation.first=observation.first===null?minute:Math.min(observation.first,minute);observation.last=observation.last===null?minute:Math.max(observation.last,minute);
      }
    }
    return result;
  }

  private analyticsExclusions(excludedBotLogins: readonly string[] = []): ReadonlySet<string> {
    const keys=new Set(botExclusionSet(excludedBotLogins));
    const json=JSON.stringify([...keys]);
    const rows=this.db.prepare(`WITH excluded_people AS (
      SELECT i.person_id FROM identities i WHERE i.match_key IN(SELECT value FROM json_each(?))
       OR (i.source='twitch' AND i.external_id=i.account_id)
       OR EXISTS(SELECT 1 FROM identity_aliases a WHERE a.identity_id=i.id AND ltrim(a.candidate_key,'@#') IN(SELECT value FROM json_each(?)))
      UNION
      SELECT y.person_id FROM youtube_identities y LEFT JOIN youtube_identity_aliases a ON a.identity_id=y.id
       WHERE y.is_owner=1 OR y.external_id=y.account_id OR y.match_key IN(SELECT value FROM json_each(?)) OR a.match_key IN(SELECT value FROM json_each(?))
    ) SELECT DISTINCT match_key FROM identities WHERE person_id IN(SELECT person_id FROM excluded_people)
      UNION SELECT DISTINCT match_key FROM youtube_identities WHERE person_id IN(SELECT person_id FROM excluded_people)
    `).all(json,json,json,json) as {match_key:string}[];
    for(const row of rows)keys.add(row.match_key);
    return keys;
  }
  botJson(excludedBotLogins: readonly string[] = []): string {
    return JSON.stringify([...this.analyticsExclusions(excludedBotLogins)]);
  }

  notBotClause(alias = "i"): string {
    return `${alias}.match_key NOT IN (SELECT value FROM json_each(?))`;
  }
  private youtubePersonActivity(personId: string, sessionId?: string, botJson = this.botJson(),chatWindowMinutes=5,fromMs=0) {
    const excluded = this.db.prepare(`SELECT 1 FROM youtube_identities y LEFT JOIN youtube_identity_aliases a ON a.identity_id=y.id WHERE y.person_id=? AND (y.is_owner=1 OR y.external_id=y.account_id OR y.match_key IN(SELECT value FROM json_each(?)) OR a.match_key IN(SELECT value FROM json_each(?))) LIMIT 1`).get(personId,botJson,botJson);
    if (excluded) return {messageCount:0,estimatedChatMinutes:0,sessionIds:new Set<string>(),firstSeenMs:null};
    const now = Date.now();
    const rows = this.db.prepare(`SELECT m.id,m.published_at_ms FROM youtube_messages m JOIN youtube_identities y ON y.account_id=m.account_id AND y.external_id=m.author_id WHERE m.published_at_ms>=${fromMs} AND y.person_id=? AND json_extract(m.payload_json,'$.snippet.type') IN('textMessageEvent','superChatEvent','superStickerEvent')`).all(personId) as {id:string;published_at_ms:number}[];
    const matched = this.db.prepare(`SELECT DISTINCT m.id,m.published_at_ms,s.id AS session_id,s.started_at_ms,coalesce(s.ended_at_ms,?) AS ended_at_ms
      FROM youtube_identities y JOIN youtube_messages m ON m.account_id=y.account_id AND m.author_id=y.external_id
      JOIN platform_streams ps ON ps.platform='youtube' AND ps.account_id=m.account_id AND m.published_at_ms>=ps.started_at_ms AND (ps.ended_at_ms IS NULL OR m.published_at_ms<ps.ended_at_ms)
      JOIN sessions s ON s.id=ps.session_id
      WHERE m.published_at_ms>=${fromMs} AND y.person_id=? AND (? IS NULL OR s.id=?) AND json_extract(m.payload_json,'$.snippet.type') IN('textMessageEvent','superChatEvent','superStickerEvent')`).all(now,personId,sessionId??null,sessionId??null) as {id:string;published_at_ms:number;session_id:string;started_at_ms:number;ended_at_ms:number}[];
    const spans = unionSpans(matched.map(row=>({session:row.session_id,kind:'chat_proxy' as const,from:Math.max(fromMs,row.started_at_ms,row.published_at_ms),to:Math.min(row.ended_at_ms,row.published_at_ms+chatWindowMinutes*60000)})));
    return {messageCount:sessionId?new Set(matched.map(row=>row.id)).size:rows.length,
      estimatedChatMinutes:spans.reduce((total,span)=>total+(span.to-span.from)/60000,0),
      sessionIds:new Set(matched.map(row=>row.session_id)),firstSeenMs:rows.length?rows.reduce((first,row)=>Math.min(first,row.published_at_ms),Infinity):null};
  }

  personStats(
    personId: string,
    sessionId?: string,
    excludedBotLogins: readonly string[] = [],
    chatWindowMinutes=5,
    fromMs=0,
  ): Record<string, unknown> {
    if(!Number.isSafeInteger(fromMs)||fromMs<0)throw new Error("INVALID_PERIOD");
    const person = this.db
      .prepare("SELECT id, display_name FROM persons WHERE id=?")
      .get(personId) as { id: string; display_name: string } | undefined;
    if (!person) throw new Error("PERSON_NOT_FOUND");
    const botJson = this.botJson(excludedBotLogins);
    const excludedPerson=Boolean(this.db.prepare(`SELECT 1 FROM identities WHERE person_id=? AND match_key IN(SELECT value FROM json_each(?)) UNION ALL SELECT 1 FROM youtube_identities WHERE person_id=? AND (is_owner=1 OR external_id=account_id OR match_key IN(SELECT value FROM json_each(?))) LIMIT 1`).get(personId,botJson,personId,botJson));
    const sid = sessionId ?? null;
    const inSession =
      `(coalesce(e.occurred_at_ms,e.received_at_ms)>=${fromMs} AND (? IS NULL OR e.id IN (SELECT event_id FROM event_sessions WHERE session_id=?)))`;
    const youtube = this.youtubePersonActivity(personId,sessionId,botJson,chatWindowMinutes,fromMs);
    const messageCount = youtube.messageCount + (
      this.db
        .prepare(
          `SELECT count(*) AS n FROM effective_events e
           JOIN identities i ON i.id = e.identity_id
           WHERE i.person_id = ? AND ${inSession}
             AND e.type = 'chat.message'
             AND (
               json_extract(e.payload_json, '$.originChannelId') IS NULL
               OR json_extract(e.payload_json, '$.originChannelId') = e.account_id
             )
             AND ${this.notBotClause("i")}`,
        )
        .get(personId, sid, sid, botJson) as { n: number }
    ).n;
    const donationRows = this.db
      .prepare(
        `SELECT json_extract(e.payload_json, '$.currency') AS currency,
                json_extract(e.payload_json, '$.amountMinor') AS amount_minor
         FROM effective_events e
         JOIN identities i ON i.id = e.identity_id
         WHERE i.person_id = ? AND ${inSession} AND e.type = 'donation' AND ${this.notBotClause('i')}
           AND json_extract(e.payload_json, '$.currency') IS NOT NULL
           AND json_extract(e.payload_json, '$.amountMinor') IS NOT NULL`,
      )
      .all(personId, sid, sid,botJson) as { currency: string; amount_minor: string }[];
    const donationTotals: Record<string, string> = {};
    for (const row of donationRows) {
      donationTotals[row.currency] = (
        BigInt(donationTotals[row.currency] ?? "0") + BigInt(row.amount_minor)
      ).toString();
    }
    const donationCount = donationRows.length;
    const eventBounds = this.db
      .prepare(
        `SELECT
           min(coalesce(e.occurred_at_ms, e.received_at_ms)) AS first_event_ms,
           max(coalesce(e.occurred_at_ms, e.received_at_ms)) AS last_event_ms
         FROM effective_events e
         JOIN identities i ON i.id = e.identity_id
         WHERE i.person_id = ? AND ${inSession}`,
      )
      .get(personId, sid, sid) as {
      first_event_ms: number | null;
      last_event_ms: number | null;
    };
    let observedMinutesThisSession: number | null = null;
    let firstObservedMs: number | null = null;
    let lastObservedMs: number | null = null;
    if (sessionId) {
      const window = this.sessionMinuteWindow(sessionId);
      const obs = this.observedMinutesForPerson(
        sessionId,
        personId,
        window.fromMs,
        window.toMs,
      );
      observedMinutesThisSession = obs.observedMinutes;
      firstObservedMs = obs.firstObservedMs;
      lastObservedMs = obs.lastObservedMs;
    } else {
      const bounds = this.db
        .prepare(
          `SELECT min(p.completed_at_ms) AS first_ms, max(p.completed_at_ms) AS last_ms
           FROM presence_polls p
           JOIN presence_members m ON m.poll_id = p.id
           JOIN identities i ON i.id = m.identity_id
           WHERE i.person_id = ? AND p.status = 'complete' AND p.completed_at_ms>=${fromMs}`,
        )
        .get(personId) as { first_ms: number | null; last_ms: number | null };
      firstObservedMs = bounds.first_ms;
      lastObservedMs = bounds.last_ms;
    }
    const sessions = this.db
      .prepare(
        `SELECT id, started_at_ms, ended_at_ms FROM sessions
         WHERE kind='platform' AND coalesce(ended_at_ms,${Date.now()})>${fromMs} ORDER BY started_at_ms DESC`,
      )
      .all() as {
      id: string;
      started_at_ms: number;
      ended_at_ms: number | null;
    }[];
    const followedAtMs = (this.db.prepare("SELECT min(e.occurred_at_ms) AS at FROM effective_events e JOIN identities i ON i.id=e.identity_id WHERE i.person_id=? AND e.type='follow'").get(personId) as {at:number|null}).at;
    let observedBeforeFollowMinutes = 0;
    let observedSum = 0;
    let observedSessions = 0;
    const attended = new Set(youtube.sessionIds);
    let offsetSum = 0;
    let offsetSessions = 0;
    const observations=excludedPerson?new Map():this.batchObserved([personId],undefined,undefined,fromMs).get(personId)??new Map();
    const beforeFollow=followedAtMs===null||excludedPerson?new Map():this.batchObserved([personId],undefined,followedAtMs,fromMs).get(personId)??new Map();
    for (const [id,obs] of observations) {
      observedBeforeFollowMinutes+=beforeFollow.get(id)?.minutes.size??0;
      if(obs.minutes.size){attended.add(id);observedSum+=obs.minutes.size;observedSessions++;
        if(obs.first!==null){offsetSum+=Math.max(0,obs.first-obs.startedAt);offsetSessions++;}
      }
    }
    return {
      personId: person.id,
      displayName: person.display_name,
      sessionId: sessionId ?? null,
      messageCount,
      donationCount,
      donationTotals,
      firstEventMs: eventBounds.first_event_ms,
      lastEventMs: eventBounds.last_event_ms,
      firstObservedMs:excludedPerson?null:firstObservedMs,
      lastObservedMs:excludedPerson?null:lastObservedMs,
      observedMinutesThisSession:excludedPerson?0:observedMinutesThisSession,
      avgObservedMinutes:
        observedSessions > 0
          ? Math.round((observedSum / observedSessions) * 1000) / 1000
          : null,
      avgFirstObservedOffsetMs:
        offsetSessions > 0
          ? Math.round(offsetSum / offsetSessions)
          : null,
      sessionsWithObservation: observedSessions,
      sessionsWithAttendance: attended.size,
      estimatedChatMinutes: youtube.estimatedChatMinutes,
      totalObservedMinutes: observedSum,
      recordedStreams: sessions.length,
      attendanceRatio: sessions.length ? attended.size / sessions.length : null,
      followedAtMs,
      watchingSinceMs: excludedPerson?null:(this.db.prepare(`SELECT min(at) AS at FROM (
        SELECT min(p.completed_at_ms) AS at FROM presence_polls p JOIN presence_members m ON m.poll_id=p.id JOIN identities i ON i.id=m.identity_id WHERE i.person_id=? AND p.status='complete'
        UNION ALL SELECT min(e.occurred_at_ms) AS at FROM effective_events e JOIN identities i ON i.id=e.identity_id WHERE i.person_id=? AND e.type='chat.message' AND (json_extract(e.payload_json,'$.originChannelId') IS NULL OR json_extract(e.payload_json,'$.originChannelId')=e.account_id)
        UNION ALL SELECT ? AS at
      )`).get(personId,personId,youtube.firstSeenMs) as {at:number|null}).at,
      observedBeforeFollowMinutes: followedAtMs === null ? null : observedBeforeFollowMinutes,
    };
  }

  personsTop(
    sortBy: "messages" | "donations" | "observed_minutes" = "messages",
    sessionId?: string,
    excludedBotLogins: readonly string[] = [],
    limit = 50,
    fromMs=0,toMs?:number,currency='RUB',
  ): Record<string, unknown>[] {
    if(!Number.isSafeInteger(fromMs)||fromMs<0)throw new Error("INVALID_PERIOD");
    if (!["messages", "donations", "observed_minutes"].includes(sortBy))
      throw new Error("INVALID_SORT");
    const capped = Math.min(Math.max(1, Math.floor(limit) || 50), 100);
    const botJson = this.botJson(excludedBotLogins);
    const sid = sessionId ?? null;
    const inSession =
      `(coalesce(e.occurred_at_ms,e.received_at_ms)>=${fromMs} AND (? IS NULL OR e.id IN (SELECT event_id FROM event_sessions WHERE session_id=?)))`;
    if(sortBy==='donations')return donorRanking(this.db,sessionId,botJson,capped,fromMs,toMs,currency);
    if (sortBy === "observed_minutes") {
      if (!sessionId) {
        // Rank exact lifetime minutes across all confirmed observations.
        const rows = this.db
          .prepare(
            `SELECT p.id, p.display_name, p.revision,
               (SELECT group_concat(DISTINCT i2.source) FROM identities i2 WHERE i2.person_id=p.id) AS sources,
               count(DISTINCT poll.id) AS poll_count
             FROM persons p
             JOIN identities i ON i.person_id = p.id
             JOIN presence_members m ON m.identity_id = i.id
             JOIN presence_polls poll ON poll.id = m.poll_id AND poll.status='complete'
             WHERE poll.completed_at_ms>=${fromMs} AND ${this.notBotClause("i")}
             GROUP BY p.id
             ORDER BY poll_count DESC, p.display_name`,
          )
          .all(botJson) as Record<string, unknown>[];
        const observations=this.batchObserved(rows.map(row=>String(row.id)),undefined,undefined,fromMs);
        return rows.map(row=>({id:row.id,display_name:row.display_name,revision:row.revision,sources:row.sources,messageCount:0,donationCount:0,donationTotals:{},observedMinutes:[...(observations.get(String(row.id))?.values()??[])].reduce((sum,obs)=>sum+obs.minutes.size,0)}))
          .sort((a,b)=>b.observedMinutes-a.observedMinutes).slice(0,capped);
      }
      this.sessionMinuteWindow(sessionId); // Preserve invalid-session validation.
      const candidates=this.db.prepare(`SELECT DISTINCT p.id,p.display_name,p.revision,
        (SELECT group_concat(DISTINCT source) FROM identities WHERE person_id=p.id) AS sources
        FROM persons p JOIN identities i ON i.person_id=p.id JOIN presence_members m ON m.identity_id=i.id JOIN presence_polls poll ON poll.id=m.poll_id
        WHERE poll.session_id=? AND poll.status='complete' AND ${this.notBotClause('i')}`).all(sessionId,botJson) as Record<string,unknown>[];
      const observations=this.batchObserved(candidates.map(row=>String(row.id)),sessionId);
      return candidates.map(row=>({id:row.id,display_name:row.display_name,revision:row.revision,sources:row.sources,messageCount:0,donationCount:0,donationTotals:{},observedMinutes:observations.get(String(row.id))?.get(sessionId)?.minutes.size??0}))
        .filter(row=>row.observedMinutes>0).sort((a,b)=>b.observedMinutes-a.observedMinutes).slice(0,capped);
    }

    const typeFilter =
      sortBy === "messages"
        ? `e.type = 'chat.message'
             AND (
               json_extract(e.payload_json, '$.originChannelId') IS NULL
               OR json_extract(e.payload_json, '$.originChannelId') = e.account_id
             )`
        : `e.type = 'donation'`;
    const rows = sortBy === "messages" ? this.db.prepare(`WITH message_counts AS (
      SELECT i.person_id,count(*) AS n FROM effective_events e JOIN identities i ON i.id=e.identity_id
      WHERE ${inSession} AND ${typeFilter} AND ${this.notBotClause("i")} GROUP BY i.person_id
      UNION ALL
      SELECT y.person_id,count(*) AS n FROM youtube_messages m JOIN youtube_identities y ON y.account_id=m.account_id AND y.external_id=m.author_id
      WHERE m.published_at_ms>=${fromMs} AND json_extract(m.payload_json,'$.snippet.type') IN('textMessageEvent','superChatEvent','superStickerEvent')
       AND (? IS NULL OR EXISTS(SELECT 1 FROM platform_streams ps JOIN sessions ss ON ss.id=ps.session_id WHERE ps.platform='youtube' AND ps.account_id=m.account_id AND ps.session_id=? AND ps.started_at_ms<=m.published_at_ms AND coalesce(ps.ended_at_ms,ss.ended_at_ms,?)>m.published_at_ms))
       AND NOT EXISTS(SELECT 1 FROM youtube_identities z LEFT JOIN youtube_identity_aliases a ON a.identity_id=z.id WHERE z.person_id=y.person_id AND (z.is_owner=1 OR z.external_id=z.account_id OR z.match_key IN(SELECT value FROM json_each(?)) OR a.match_key IN(SELECT value FROM json_each(?))))
      GROUP BY y.person_id
    ) SELECT p.id,p.display_name,p.revision,sum(c.n) AS metric_count,
      (SELECT group_concat(DISTINCT source) FROM (SELECT source FROM identities WHERE person_id=p.id UNION ALL SELECT 'youtube' AS source FROM youtube_identities WHERE person_id=p.id)) AS sources
      FROM persons p JOIN message_counts c ON c.person_id=p.id GROUP BY p.id ORDER BY metric_count DESC,p.display_name LIMIT ?
    `).all(sid,sid,botJson,sid,sid,Date.now(),botJson,botJson,capped) as Record<string,unknown>[] : this.db
      .prepare(
        `SELECT p.id, p.display_name, p.revision,
           (SELECT group_concat(DISTINCT i2.source) FROM identities i2 WHERE i2.person_id=p.id) AS sources,
           count(e.id) AS metric_count
         FROM persons p
         JOIN identities i ON i.person_id = p.id
         JOIN effective_events e ON e.identity_id = i.id
         WHERE ${inSession} AND ${typeFilter}
           AND ${this.notBotClause("i")}
         GROUP BY p.id
         ORDER BY metric_count DESC, p.display_name
         LIMIT ?`,
      )
      .all(sid, sid, botJson, capped) as Record<string, unknown>[];

    const selectedIds=JSON.stringify(rows.map(row=>row.id));
    const donations=this.db.prepare(`SELECT i.person_id,json_extract(e.payload_json,'$.currency') AS currency,json_extract(e.payload_json,'$.amountMinor') AS amount_minor FROM effective_events e JOIN identities i ON i.id=e.identity_id WHERE i.person_id IN(SELECT value FROM json_each(?)) AND ${inSession} AND e.type='donation' AND json_extract(e.payload_json,'$.currency') IS NOT NULL AND json_extract(e.payload_json,'$.amountMinor') IS NOT NULL`).all(selectedIds,sid,sid) as {person_id:string;currency:string;amount_minor:string}[];
    const tipsByPerson=new Map<string,typeof donations>();for(const tip of donations){const list=tipsByPerson.get(tip.person_id)??[];list.push(tip);tipsByPerson.set(tip.person_id,list);}
    const counts=sortBy==='messages'?[]:this.db.prepare(`SELECT i.person_id,count(*) AS n FROM effective_events e JOIN identities i ON i.id=e.identity_id WHERE i.person_id IN(SELECT value FROM json_each(?)) AND ${inSession} AND e.type='chat.message' AND (json_extract(e.payload_json,'$.originChannelId') IS NULL OR json_extract(e.payload_json,'$.originChannelId')=e.account_id) AND ${this.notBotClause('i')} GROUP BY i.person_id`).all(selectedIds,sid,sid,botJson) as {person_id:string;n:number}[];
    const messages=new Map(counts.map(row=>[row.person_id,row.n]));
    const observations=sessionId?this.batchObserved(rows.map(row=>String(row.id)),sessionId):null;
    return rows.map((row) => {
      const donationRows=tipsByPerson.get(String(row.id))??[];
      const donationTotals:Record<string,string>={};
      for(const tip of donationRows)donationTotals[tip.currency]=(BigInt(donationTotals[tip.currency]??'0')+BigInt(tip.amount_minor)).toString();
      const messageCount=sortBy==='messages'?Number(row.metric_count):messages.get(String(row.id))??0;
      const observedMinutes=sessionId?observations?.get(String(row.id))?.get(sessionId)?.minutes.size??0:0;
      return {
        id: row.id,
        display_name: row.display_name,
        revision: row.revision,
        sources: row.sources,
        messageCount,
        donationCount: donationRows.length,
        donationTotals,
        observedMinutes,
      };
    });
  }

  insights(
    sessionId?: string,
    excludedBotLogins: readonly string[] = [],
  ): Record<string, unknown>[] {
    const botJson = this.botJson(excludedBotLogins);
    const cards: Record<string, unknown>[] = [];
    const sessions = this.db
      .prepare(
        "SELECT id, started_at_ms, ended_at_ms FROM sessions ORDER BY started_at_ms DESC LIMIT 50",
      )
      .all() as {
      id: string;
      started_at_ms: number;
      ended_at_ms: number | null;
    }[];
    const focus =
      sessionId !== undefined
        ? sessions.find((s) => s.id === sessionId)
        : sessions[0];
    if (!focus) return cards;

    const window = this.sessionMinuteWindow(focus.id);
    const sid = focus.id;
    const inSession =
      "e.id IN (SELECT event_id FROM event_sessions WHERE session_id=?)";

    // Regulars: observed in >= 3 sessions with avg >= 5 observed minutes
    const personIds = this.db
      .prepare(
        `SELECT DISTINCT i.person_id AS id, p.display_name
         FROM identities i
         JOIN persons p ON p.id = i.person_id
         WHERE ${this.notBotClause("i")}`,
      )
      .all(botJson) as { id: string; display_name: string }[];
    for (const person of personIds) {
      let hitSessions = 0;
      let minuteSum = 0;
      for (const session of sessions) {
        const fromMs = Math.floor(session.started_at_ms / 60_000) * 60_000;
        const endMs = session.ended_at_ms ?? Date.now();
        let toMs = Math.ceil(endMs / 60_000) * 60_000;
        if (toMs - fromMs > 31 * 86_400_000 || toMs <= fromMs) continue;
        const obs = this.observedMinutesForPerson(
          session.id,
          person.id,
          fromMs,
          toMs,
        );
        if (obs.observedMinutes >= 5) {
          hitSessions += 1;
          minuteSum += obs.observedMinutes;
        }
      }
      if (hitSessions >= 3) {
        cards.push({
          kind: "regular",
          title: "Постоянный участник",
          detail: `${person.display_name}: ≥5 наблюдаемых минут в ${hitSessions} сессиях`,
          personId: person.id,
          sessionId: sid,
          metrics: {
            sessions: hitSessions,
            avgObservedMinutes: Math.round((minuteSum / hitSessions) * 10) / 10,
          },
        });
      }
    }

    // Per-person message + observed for focus session
    const msgRows = this.db
      .prepare(
        `SELECT i.person_id AS id, max(p.display_name) AS display_name, count(*) AS messages
         FROM effective_events e
         JOIN identities i ON i.id = e.identity_id
         JOIN persons p ON p.id = i.person_id
         WHERE ${inSession} AND e.type = 'chat.message'
           AND (
             json_extract(e.payload_json, '$.originChannelId') IS NULL
             OR json_extract(e.payload_json, '$.originChannelId') = e.account_id
           )
           AND ${this.notBotClause("i")}
         GROUP BY i.person_id`,
      )
      .all(sid, botJson) as { id: string; display_name: string; messages: number }[];
    const msgMap = new Map(msgRows.map((r) => [r.id, r]));
    const presentIds = this.db
      .prepare(
        `SELECT DISTINCT i.person_id AS id, p.display_name
         FROM presence_members m
         JOIN presence_polls poll ON poll.id = m.poll_id
         JOIN identities i ON i.id = m.identity_id
         JOIN persons p ON p.id = i.person_id
         WHERE poll.session_id = ? AND poll.status = 'complete'
           AND ${this.notBotClause("i")}`,
      )
      .all(sid, botJson) as { id: string; display_name: string }[];

    for (const row of msgRows) {
      if (row.messages < 5) continue;
      const obs = this.observedMinutesForPerson(
        sid,
        row.id,
        window.fromMs,
        window.toMs,
      );
      if (obs.observedMinutes === 0) {
        cards.push({
          kind: "chatty_absent",
          title: "Пишет, но не наблюдался",
          detail: `${row.display_name}: ${row.messages} сообщ., 0 наблюдаемых минут`,
          personId: row.id,
          sessionId: sid,
          metrics: { messages: row.messages, observedMinutes: 0 },
        });
      }
    }

    for (const row of presentIds) {
      const obs = this.observedMinutesForPerson(
        sid,
        row.id,
        window.fromMs,
        window.toMs,
      );
      const messages = msgMap.get(row.id)?.messages ?? 0;
      if (obs.observedMinutes >= 10 && messages === 0) {
        cards.push({
          kind: "silent_presence",
          title: "Тихое присутствие",
          detail: `${row.display_name}: ${obs.observedMinutes} наблюдаемых минут без сообщений`,
          personId: row.id,
          sessionId: sid,
          metrics: { messages: 0, observedMinutes: obs.observedMinutes },
        });
      }
    }

    // Donor without Twitch link
    const donors = this.db
      .prepare(
        `SELECT p.id, p.display_name,
           EXISTS(SELECT 1 FROM identities i WHERE i.person_id=p.id AND i.source='twitch') AS has_twitch,
           EXISTS(SELECT 1 FROM identities i WHERE i.person_id=p.id AND i.source='donationalerts') AS has_da
         FROM persons p
         WHERE EXISTS(
           SELECT 1 FROM effective_events e
           JOIN identities i ON i.id = e.identity_id
           WHERE i.person_id = p.id AND e.type = 'donation' AND ${inSession} AND ${this.notBotClause("i")}
         )`,
      )
      .all(sid, botJson) as {
      id: string;
      display_name: string;
      has_twitch: number;
      has_da: number;
    }[];
    for (const d of donors) {
      if (d.has_da && !d.has_twitch) {
        cards.push({
          kind: "donor_no_twitch",
          title: "Донат без Twitch",
          detail: `${d.display_name}: есть DonationAlerts, нет связанного Twitch`,
          personId: d.id,
          sessionId: sid,
          metrics: {},
        });
      }
    }

    const sessionPeople = [...new Map([...msgRows,...presentIds].map(p=>[p.id,p])).values()];
    // Returning after long gap (>= 14 days since prior activity)
    const fourteen = 14 * 86_400_000;
    for (const person of sessionPeople) {
      const priorLast = this.db
        .prepare(
          `SELECT max(ts) AS last_ms FROM (
             SELECT coalesce(e.occurred_at_ms, e.received_at_ms) AS ts
             FROM effective_events e JOIN identities i ON i.id = e.identity_id
             WHERE i.person_id = ? AND e.id NOT IN (
               SELECT event_id FROM event_sessions WHERE session_id = ?
             )
             UNION ALL
             SELECT poll.completed_at_ms AS ts
             FROM presence_polls poll
             JOIN presence_members m ON m.poll_id = poll.id
             JOIN identities i ON i.id = m.identity_id
             WHERE i.person_id = ? AND poll.session_id != ? AND poll.status='complete'
           )`,
        )
        .get(person.id, sid, person.id, sid) as { last_ms: number | null };
      if (
        priorLast.last_ms !== null &&
        focus.started_at_ms - priorLast.last_ms >= fourteen
      ) {
        const days = Math.round(
          (focus.started_at_ms - priorLast.last_ms) / 86_400_000,
        );
        cards.push({
          kind: "returning_after_gap",
          title: "Вернулся после паузы",
          detail: `${person.display_name}: ~${days} дн. с прошлой активности`,
          personId: person.id,
          sessionId: sid,
          metrics: { gapMs: focus.started_at_ms - priorLast.last_ms, days },
        });
      }
    }

    // Cap cards to keep UI light
    return cards.slice(0, 40);
  }

}
