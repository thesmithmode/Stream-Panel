import { audienceAnalytics, type AnalyticsOptions } from "./analytics.js";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { openProfileDatabase } from "./profile-db.js";
import {
  candidateKey,
  matchKey,
  daDonorExternalId,
  eventKey,
  assertTimestamp,
  type EventInput,
  type Source,
} from "./domain.js";
import { CURRENT_SCHEMA_VERSION, schemaV1, schemaV2, schemaV3, schemaV4, schemaV5, schemaV6, schemaV7 } from "./schema.js";
import { botExclusionSet } from "./bots.js";
import { presenceMinutes, pollCoveredMinutes, type PresencePoll } from "./presence.js";

interface IdentityRow {
  id: string;
  person_id: string;
}
interface PersonRow {
  id: string;
  revision: number;
}
interface Membership {
  id: string;
  personId: string;
}
interface MergeRow {
  before_json: string;
  expected_json: string;
  source_person_id: string;
  target_person_id: string;
  undone_at_ms: number | null;
}

export const priorModerationQuery = `SELECT 1 FROM events WHERE source='twitch' AND account_id=?
        AND type IN ('chat.message_delete','chat.clear','chat.clear_user_messages') AND (
          (type='chat.message_delete' AND json_extract(payload_json,'$.targetMessageId')=?) OR
          (occurred_at_ms>=? AND (type='chat.clear' OR
          (type='chat.clear_user_messages' AND json_extract(payload_json,'$.targetUserId')=?)))) LIMIT 1`;

export class StreamStore {
  private readonly db: Database.Database;

  constructor(path: string, private readonly profile?: string) {
    this.db = openProfileDatabase(path, profile);
    try {
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 5000");
      const version = this.db.pragma("user_version", { simple: true });
      if (typeof version !== "number" || !Number.isInteger(version) || version < 0 || version > CURRENT_SCHEMA_VERSION)
        throw new Error("UNSUPPORTED_SCHEMA_VERSION");
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      if (version === 0) this.db.transaction(() => this.db.exec(schemaV1)).immediate();
      if ((this.db.pragma("user_version", { simple: true }) as number) < 2)
        this.db.transaction(() => this.db.exec(schemaV2)).immediate();
      if ((this.db.pragma("user_version", { simple: true }) as number) < 3) {
        this.db.transaction(() => {
          this.db.exec(schemaV3);
          const rows = this.db
            .prepare("SELECT id, display_name FROM identities")
            .all() as { id: string; display_name: string }[];
          const update = this.db.prepare(
            "UPDATE identities SET match_key = ? WHERE id = ?",
          );
          for (const row of rows)
            update.run(matchKey(row.display_name), row.id);
        }).immediate();
      }
      if ((this.db.pragma("user_version", { simple: true }) as number) < 4)
        this.db.transaction(() => this.db.exec(schemaV4)).immediate();
      if ((this.db.pragma("user_version", { simple: true }) as number) < 5)
        this.db.transaction(() => this.db.exec(schemaV5)).immediate();
      if ((this.db.pragma("user_version", { simple: true }) as number) < 6)
        this.db.transaction(() => this.db.exec(schemaV6)).immediate();
      if ((this.db.pragma("user_version", { simple: true }) as number) < 7)
        this.db.transaction(() => this.db.exec(schemaV7)).immediate();
      this.db.exec("CREATE TABLE IF NOT EXISTS sp_youtube_quota (day TEXT NOT NULL, profile TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY(day,profile)) WITHOUT ROWID");
      // Viewer = Twitch identity (stable user id). Donor = DA identity (account+name).
      // Person = link umbrella. Collapse historical per-tip DA identity dupes.
      this.db.transaction(() => this.collapseDuplicateDaDonors()).immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

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
  analytics(options: AnalyticsOptions) { return audienceAnalytics(this.db,options); }

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
    this.db.prepare("INSERT INTO youtube_snapshots VALUES (?,?,?,?) ON CONFLICT(account_id,key) DO UPDATE SET payload_json=excluded.payload_json,updated_at_ms=excluded.updated_at_ms").run(account, key, JSON.stringify(payload), now);
  }
  youtubeMessages(account: string, chat: string, messages: any[]): void {
    if (!account || !chat || messages.length > 2000) throw new Error("INVALID_YOUTUBE_MESSAGES");
    this.db.transaction(() => {
      const insert = this.db.prepare("INSERT OR IGNORE INTO youtube_messages VALUES (?,?,?,?,?,?)");
      for (const m of messages) {
        const time = Date.parse(m.snippet?.publishedAt ?? "");
        if (!m.id || !Number.isFinite(time)) continue;
        if (m.snippet.type === "messageDeletedEvent") this.db.prepare("DELETE FROM youtube_messages WHERE account_id=? AND id=?").run(account, m.snippet.messageDeletedDetails?.deletedMessageId ?? "");
        if (m.snippet.type === "userBannedEvent") this.db.prepare("DELETE FROM youtube_messages WHERE account_id=? AND author_id=?").run(account, m.snippet.userBannedDetails?.bannedUserDetails?.channelId ?? "");
        insert.run(m.id, account, chat, m.authorDetails?.channelId ?? "", time, JSON.stringify(m));
      }
    }).immediate();
  }
  youtubeData(account: string) {
    const snapshots = this.db.prepare("SELECT key,payload_json,updated_at_ms FROM youtube_snapshots WHERE account_id=?").all(account) as {key:string;payload_json:string;updated_at_ms:number}[];
    const messages = this.db.prepare("SELECT payload_json FROM youtube_messages WHERE account_id=? ORDER BY published_at_ms DESC,id DESC LIMIT 200").all(account) as {payload_json:string}[];
    return { snapshots: Object.fromEntries(snapshots.map(r => [r.key, {data: JSON.parse(r.payload_json), updatedAt: r.updated_at_ms}])), messages: messages.map(r => JSON.parse(r.payload_json)) };
  }

  ingest(event: EventInput): {
    inserted: boolean;
    identityId: string | null;
    personId: string | null;
  } {
    assertTimestamp(event.receivedAtMs);
    if (event.occurredAtMs !== null) assertTimestamp(event.occurredAtMs);
    if ([event.accountId, event.externalId, event.type].some((value) => !value))
      throw new Error("MISSING_EVENT_KEY");
    if ((event.timeQuality === "unknown") !== (event.occurredAtMs === null))
      throw new Error("INVALID_TIME_QUALITY");
    if (event.source === "donationalerts" && event.actor) {
      // Donor identity is name-scoped; event.externalId remains the donation occurrence id.
      if (event.actor.externalId !== daDonorExternalId(event.actor.displayName))
        throw new Error("DA_ACTOR_MUST_BE_DONOR_NAME");
    }
    if (event.actor && !event.actor.externalId)
      throw new Error("MISSING_ACTOR_KEY");
    const payload = JSON.stringify(event.payload); // Fails before writing on BigInt/cycles.
    return this.db.transaction(() => {
      const previous = this.db
        .prepare(`SELECT identity_id AS id FROM events WHERE id = ?`)
        .get(eventKey(event)) as { id: string | null } | undefined;
      if (previous) {
        const identity = previous.id
          ? (this.db
              .prepare("SELECT id, person_id FROM identities WHERE id = ?")
              .get(previous.id) as IdentityRow)
          : null;
        return {
          inserted: false,
          identityId: previous.id,
          personId: identity?.person_id ?? null,
        };
      }
      let identity: IdentityRow | null = null;
      let newIdentity = false;
      let autoLinked = false;
      if (event.actor) {
        identity =
          (this.db
            .prepare(
              "SELECT id, person_id FROM identities WHERE source = ? AND account_id = ? AND external_id = ?",
            )
            .get(event.source, event.accountId, event.actor.externalId) as
            | IdentityRow
            | undefined) ?? null;
        // Legacy DA rows keyed donation id per tip — reuse Donor by match_key.
        if (!identity && event.source === "donationalerts") {
          const key = matchKey(event.actor.displayName);
          if (key) {
            identity =
              (this.db
                .prepare(
                  `SELECT id, person_id FROM identities
                   WHERE source = 'donationalerts' AND account_id = ? AND match_key = ?
                   ORDER BY CASE WHEN external_id LIKE 'name:%' THEN 0 ELSE 1 END, id
                   LIMIT 1`,
                )
                .get(event.accountId, key) as IdentityRow | undefined) ?? null;
            if (identity) {
              // Promote legacy occurrence-keyed Donor to stable name key when free.
              const stable = daDonorExternalId(event.actor.displayName);
              const taken = this.db
                .prepare(
                  "SELECT id FROM identities WHERE source = ? AND account_id = ? AND external_id = ?",
                )
                .get("donationalerts", event.accountId, stable) as
                | { id: string }
                | undefined;
              if (!taken) {
                this.db
                  .prepare("UPDATE identities SET external_id = ? WHERE id = ?")
                  .run(stable, identity.id);
              }
            }
          }
        }
        if (!identity) {
          newIdentity = true;
          const linked = this.resolveAutoLinkPerson(
            event.source,
            event.accountId,
            event.actor.externalId,
            event.actor.displayName,
          );
          const personId = linked?.personId ?? randomUUID();
          autoLinked = linked !== null;
          identity = { id: randomUUID(), person_id: personId };
          if (!linked) {
            this.db
              .prepare("INSERT INTO persons(id, display_name) VALUES (?, ?)")
              .run(personId, event.actor.displayName);
          }
          this.db
            .prepare(
              `INSERT INTO identities(id, source, account_id, external_id, display_name, candidate_key, person_id, match_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              identity.id,
              event.source,
              event.accountId,
              event.actor.externalId,
              event.actor.displayName,
              candidateKey(event.actor.displayName),
              personId,
              matchKey(event.actor.displayName),
            );
          if (linked) {
            const how =
              event.source === "twitch" &&
              event.actor.externalId === event.accountId
                ? "owner"
                : linked.how;
            this.db
              .prepare(
                "INSERT INTO membership_operations VALUES (?, ?, ?, ?, ?)",
              )
              .run(
                randomUUID(),
                "auto_link",
                JSON.stringify([]),
                JSON.stringify([
                  {
                    id: identity.id,
                    personId,
                    how,
                  },
                ]),
                event.receivedAtMs,
              );
            this.db
              .prepare("UPDATE persons SET revision = revision + 1 WHERE id = ?")
              .run(personId);
          }
        } else {
          this.db
            .prepare(
              "UPDATE identities SET display_name = ?, candidate_key = ?, match_key = ? WHERE id = ?",
            )
            .run(
              event.actor.displayName,
              candidateKey(event.actor.displayName),
              matchKey(event.actor.displayName),
              identity.id,
            );
        }
      }
      this.db
        .prepare(
          `INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          eventKey(event),
          event.source,
          event.accountId,
          event.externalId,
          event.type,
          identity?.id ?? null,
          event.occurredAtMs,
          event.receivedAtMs,
          event.sourceTime,
          event.timeQuality,
          event.transport,
          payload,
        );
      if (
        event.source === "twitch" &&
        [
          "chat.message_delete",
          "chat.clear",
          "chat.clear_user_messages",
        ].includes(event.type)
      ) {
        const messageId = String(event.payload.targetMessageId ?? "");
        const userId = String(event.payload.targetUserId ?? "");
        const atMs = event.occurredAtMs ?? event.receivedAtMs;
        const scope = this.moderationScope(event.accountId, atMs);
        // Flag only — never overwrite original message text.
        if (event.type === "chat.clear")
          this.db
            .prepare(
              `UPDATE events SET payload_json=json_set(payload_json, '$.redacted', 1)
               WHERE source='twitch' AND account_id=? AND type='chat.message'
               AND occurred_at_ms<=? AND occurred_at_ms>=?`,
            )
            .run(event.accountId, atMs, scope);
        else if (event.type === "chat.message_delete" && messageId)
          this.db
            .prepare(
              `UPDATE events SET payload_json=json_set(payload_json, '$.redacted', 1)
               WHERE source='twitch' AND account_id=? AND type='chat.message' AND external_id=?`,
            )
            .run(event.accountId, messageId);
        else if (event.type === "chat.clear_user_messages" && userId)
          this.db
            .prepare(
              `UPDATE events SET payload_json=json_set(payload_json, '$.redacted', 1)
               WHERE source='twitch' AND account_id=? AND type='chat.message'
               AND identity_id IN(SELECT id FROM identities WHERE source='twitch' AND account_id=? AND external_id=?)
               AND occurred_at_ms<=? AND occurred_at_ms>=?`,
            )
            .run(event.accountId, event.accountId, userId, atMs, scope);
      }
      if (event.source === "twitch" && event.type === "chat.message") {
        const deletion = this.db
          .prepare(priorModerationQuery)
          .get(
            event.accountId,
            event.externalId,
            event.occurredAtMs,
            event.actor?.externalId ?? "",
          );
        if (deletion)
          this.db
            .prepare(
              "UPDATE events SET payload_json=json_set(payload_json,'$.redacted',1) WHERE id=?",
            )
            .run(eventKey(event));
      }
      if (identity && event.actor)
        this.rememberAlias(
          identity.id,
          event.actor.displayName,
          event.receivedAtMs,
        );
      if (event.occurredAtMs !== null)
        this.assignEvent(eventKey(event), event.accountId, event.occurredAtMs);
      // Membership changes invalidate outstanding undo revisions, including arrival of a new identity.
      // Auto-link already bumped revision when attaching to an existing person.
      if (identity && newIdentity && !autoLinked)
        this.db
          .prepare("UPDATE persons SET revision = revision + 1 WHERE id = ?")
          .run(identity.person_id);
      return {
        inserted: true,
        identityId: identity?.id ?? null,
        personId: identity?.person_id ?? null,
      };
    }).immediate();
  }

  personRevision(id: string): number {
    const person = this.db
      .prepare("SELECT id, revision FROM persons WHERE id = ?")
      .get(id) as PersonRow | undefined;
    if (!person) throw new Error("PERSON_NOT_FOUND");
    return person.revision;
  }

  private memberships(personIds: string[]): Membership[] {
    return this.db
      .prepare(
        `SELECT id, person_id AS personId FROM identities WHERE person_id IN (${personIds.map(() => "?").join(",")}) ORDER BY id`,
      )
      .all(...personIds) as Membership[];
  }

  merge(
    sourceId: string,
    targetId: string,
    sourceRevision: number,
    targetRevision: number,
    nowMs: number,
  ): string {
    assertTimestamp(nowMs);
    if (sourceId === targetId) throw new Error("SAME_PERSON");
    return this.db.transaction(() => {
      if (
        this.personRevision(sourceId) !== sourceRevision ||
        this.personRevision(targetId) !== targetRevision
      )
        throw new Error("REVISION_CONFLICT");
      const before = this.memberships([sourceId, targetId]);
      if (
        !before.some((value) => value.personId === sourceId) ||
        !before.some((value) => value.personId === targetId)
      )
        throw new Error("EMPTY_PERSON");
      this.db
        .prepare("UPDATE identities SET person_id = ? WHERE person_id = ?")
        .run(targetId, sourceId);
      this.db
        .prepare(
          "UPDATE persons SET revision = revision + 1 WHERE id IN (?, ?)",
        )
        .run(sourceId, targetId);
      const id = randomUUID();
      const expected = {
        members: this.memberships([sourceId, targetId]),
        sourceRevision: sourceRevision + 1,
        targetRevision: targetRevision + 1,
      };
      this.db
        .prepare("INSERT INTO person_merges VALUES (?, ?, ?, ?, ?, ?, NULL)")
        .run(
          id,
          sourceId,
          targetId,
          JSON.stringify(before),
          JSON.stringify(expected),
          nowMs,
        );
      return id;
    }).immediate();
  }

  undoMerge(mergeId: string, nowMs: number): void {
    assertTimestamp(nowMs);
    this.db.transaction(() => {
      const merge = this.db
        .prepare("SELECT * FROM person_merges WHERE id = ?")
        .get(mergeId) as MergeRow | undefined;
      if (!merge) throw new Error("MERGE_NOT_FOUND");
      if (merge.undone_at_ms !== null) throw new Error("ALREADY_UNDONE");
      const expected = JSON.parse(merge.expected_json) as {
        members: Membership[];
        sourceRevision: number;
        targetRevision: number;
      };
      if (
        this.personRevision(merge.source_person_id) !==
          expected.sourceRevision ||
        this.personRevision(merge.target_person_id) !==
          expected.targetRevision ||
        JSON.stringify(
          this.memberships([merge.source_person_id, merge.target_person_id]),
        ) !== JSON.stringify(expected.members)
      )
        throw new Error("UNDO_CONFLICT");
      for (const member of JSON.parse(merge.before_json) as Membership[]) {
        this.db
          .prepare("UPDATE identities SET person_id = ? WHERE id = ?")
          .run(member.personId, member.id);
      }
      this.db
        .prepare(
          "UPDATE persons SET revision = revision + 1 WHERE id IN (?, ?)",
        )
        .run(merge.source_person_id, merge.target_person_id);
      this.db
        .prepare("UPDATE person_merges SET undone_at_ms = ? WHERE id = ?")
        .run(nowMs, mergeId);
    }).immediate();
  }


  /**
   * Repair historical DA Person/Donor duplication: same recipient account +
   * same display match_key must be ONE Donor identity under ONE Person when
   * unambiguous (persons whose membership is only that DA name group).
   * Viewer (Twitch) identities are never collapsed by name.
   * Never moves events across a non-mergeable (e.g. Twitch-linked) person
   * boundary — only collapses within a mergeable set or within one person.
   */
  collapseDuplicateDaDonors(): void {
    const groups = this.db
      .prepare(
        `SELECT account_id, match_key
         FROM identities
         WHERE source = 'donationalerts' AND match_key != ''
         GROUP BY account_id, match_key
         HAVING COUNT(*) > 1`,
      )
      .all() as { account_id: string; match_key: string }[];
    for (const group of groups) {
      const rows = this.db
        .prepare(
          `SELECT id, person_id AS personId, external_id AS externalId
           FROM identities
           WHERE source = 'donationalerts' AND account_id = ? AND match_key = ?`,
        )
        .all(group.account_id, group.match_key) as {
        id: string;
        personId: string;
        externalId: string;
      }[];
      if (rows.length <= 1) continue;
      const ids = rows.map((r) => r.id);
      const idMeta = new Map(
        rows.map((r) => [r.id, { personId: r.personId, externalId: r.externalId }]),
      );
      const personIds = [...new Set(rows.map((r) => r.personId))];

      const mergeable: string[] = [];
      const protectedPersons: string[] = [];
      for (const personId of personIds) {
        const members = this.db
          .prepare(
            "SELECT id, match_key, source FROM identities WHERE person_id = ?",
          )
          .all(personId) as { id: string; match_key: string; source: string }[];
        const pure = members.every(
          (m) =>
            m.source === "donationalerts" &&
            m.match_key === group.match_key &&
            ids.includes(m.id),
        );
        if (pure) mergeable.push(personId);
        else protectedPersons.push(personId);
      }

      const eventCount = (identityId: string): number => {
        const row = this.db
          .prepare("SELECT count(*) AS n FROM events WHERE identity_id = ?")
          .get(identityId) as { n: number };
        return row.n;
      };
      const personEventCount = (personId: string): number => {
        const row = this.db
          .prepare(
            `SELECT count(*) AS n FROM events e
             JOIN identities i ON i.id = e.identity_id
             WHERE i.person_id = ?`,
          )
          .get(personId) as { n: number };
        return row.n;
      };

      if (mergeable.length > 0) {
        mergeable.sort((a, b) => {
          const aHasName = rows.some(
            (r) => r.personId === a && r.externalId.startsWith("name:"),
          );
          const bHasName = rows.some(
            (r) => r.personId === b && r.externalId.startsWith("name:"),
          );
          if (aHasName !== bHasName) return aHasName ? -1 : 1;
          const d = personEventCount(b) - personEventCount(a);
          if (d !== 0) return d;
          return a < b ? -1 : a > b ? 1 : 0;
        });
        const mergeableTarget = mergeable[0]!;
        for (const source of mergeable.slice(1)) {
          this.db
            .prepare("UPDATE identities SET person_id = ? WHERE person_id = ?")
            .run(mergeableTarget, source);
          this.db
            .prepare(
              "UPDATE persons SET revision = revision + 1 WHERE id IN (?, ?)",
            )
            .run(source, mergeableTarget);
          for (const meta of idMeta.values()) {
            if (meta.personId === source) meta.personId = mergeableTarget;
          }
        }
      }

      const buckets = new Map<string, string[]>();
      for (const id of ids) {
        const personId = idMeta.get(id)!.personId;
        const list = buckets.get(personId) ?? [];
        list.push(id);
        buckets.set(personId, list);
      }

      const stable = `name:${group.match_key}`;
      for (const [, bucket] of buckets) {
        if (bucket.length <= 1) continue;
        const scored = [...bucket].sort((a, b) => {
          const aName = idMeta.get(a)!.externalId.startsWith("name:");
          const bName = idMeta.get(b)!.externalId.startsWith("name:");
          if (aName !== bName) return aName ? -1 : 1;
          const aProt = protectedPersons.includes(idMeta.get(a)!.personId);
          const bProt = protectedPersons.includes(idMeta.get(b)!.personId);
          if (aProt !== bProt) return aProt ? -1 : 1;
          const d = eventCount(b) - eventCount(a);
          if (d !== 0) return d;
          return a < b ? -1 : a > b ? 1 : 0;
        });
        let canonical = scored[0]!;
        const taken = this.db
          .prepare(
            "SELECT id FROM identities WHERE source = 'donationalerts' AND account_id = ? AND external_id = ?",
          )
          .get(group.account_id, stable) as { id: string } | undefined;
        if (taken && bucket.includes(taken.id)) canonical = taken.id;
        else if (!idMeta.get(canonical)!.externalId.startsWith("name:")) {
          if (!taken) {
            this.db
              .prepare("UPDATE identities SET external_id = ? WHERE id = ?")
              .run(stable, canonical);
            idMeta.get(canonical)!.externalId = stable;
          }
        }
        for (const id of bucket) {
          if (id === canonical) continue;
          this.db
            .prepare("UPDATE events SET identity_id = ? WHERE identity_id = ?")
            .run(canonical, id);
          const polls = this.db
            .prepare(
              "SELECT poll_id AS pollId FROM presence_members WHERE identity_id = ?",
            )
            .all(id) as { pollId: string }[];
          const insertMember = this.db.prepare(
            "INSERT OR IGNORE INTO presence_members(poll_id, identity_id) VALUES (?, ?)",
          );
          for (const row of polls) insertMember.run(row.pollId, canonical);
          this.db
            .prepare("DELETE FROM presence_members WHERE identity_id = ?")
            .run(id);
          const aliases = this.db
            .prepare(
              "SELECT name, candidate_key, first_seen_ms, last_seen_ms FROM identity_aliases WHERE identity_id = ?",
            )
            .all(id) as {
            name: string;
            candidate_key: string;
            first_seen_ms: number;
            last_seen_ms: number;
          }[];
          const upsertAlias = this.db.prepare(
            `INSERT INTO identity_aliases(identity_id, name, candidate_key, first_seen_ms, last_seen_ms)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(identity_id, name) DO UPDATE SET
               last_seen_ms = CASE
                 WHEN excluded.last_seen_ms > identity_aliases.last_seen_ms
                 THEN excluded.last_seen_ms ELSE identity_aliases.last_seen_ms END,
               first_seen_ms = CASE
                 WHEN excluded.first_seen_ms < identity_aliases.first_seen_ms
                 THEN excluded.first_seen_ms ELSE identity_aliases.first_seen_ms END`,
          );
          for (const a of aliases)
            upsertAlias.run(
              canonical,
              a.name,
              a.candidate_key,
              a.first_seen_ms,
              a.last_seen_ms,
            );
          this.db
            .prepare("DELETE FROM identity_aliases WHERE identity_id = ?")
            .run(id);
          this.db.prepare("DELETE FROM identities WHERE id = ?").run(id);
        }
        this.db
          .prepare("INSERT INTO membership_operations VALUES (?, ?, ?, ?, ?)")
          .run(
            randomUUID(),
            "da_donor_collapse",
            JSON.stringify({ ids: bucket, match_key: group.match_key }),
            JSON.stringify({ canonical, external_id: stable }),
            Date.now(),
          );
      }
    }
  }

  /**
   * High-confidence auto-link target person id, or null.
   * Exact platform id / Donor name key is handled by caller lookup.
   * Strong name: unique cross-source match_key (exactly one person) — FR07 KEEP.
   * Same-source DA fallback: if a Donor identity was not reused, attach a new
   * Donor row to an existing Person that already owns that DA match_key
   * (historical repair path). Prefer one Donor identity per name going forward.
   */
  private resolveAutoLinkPerson(
    source: Source,
    accountId: string,
    _externalId: string,
    displayName: string,
  ): { personId: string; how: string } | null {
    const key = matchKey(displayName);
    if (!key) return null;
    const other = source === "twitch" ? "donationalerts" : "twitch";
    const rows = this.db
      .prepare(
        `SELECT DISTINCT person_id FROM identities
         WHERE source = ? AND match_key = ?`,
      )
      .all(other, key) as { person_id: string }[];
    if (rows.length === 1) return { personId: rows[0]!.person_id, how: "login_match" };
    // DA actor external_id is the donation occurrence id, so reuse by name.
    if (source === "donationalerts") {
      const same = this.db
        .prepare(
          `SELECT DISTINCT person_id FROM identities
           WHERE source = 'donationalerts' AND account_id = ? AND match_key = ?
           ORDER BY person_id`,
        )
        .all(accountId, key) as { person_id: string }[];
      if (same.length >= 1)
        return { personId: same[0]!.person_id, how: "da_name_attach" };
    }
    return null;
  }

  /** Ensure the broadcaster Twitch identity/person exists (owner auto-bind). */
  ensureOwnerIdentity(
    accountId: string,
    userId: string,
    displayName: string,
    atMs: number,
  ): string {
    assertTimestamp(atMs);
    return this.db.transaction(() => {
      const existing = this.db
        .prepare(
          "SELECT id, person_id FROM identities WHERE source='twitch' AND account_id=? AND external_id=?",
        )
        .get(accountId, userId) as IdentityRow | undefined;
      if (existing) {
        this.db
          .prepare(
            "UPDATE identities SET display_name=?, candidate_key=?, match_key=? WHERE id=?",
          )
          .run(
            displayName,
            candidateKey(displayName),
            matchKey(displayName),
            existing.id,
          );
        this.rememberAlias(existing.id, displayName, atMs);
        return existing.person_id;
      }
      const personId = randomUUID();
      const identityId = randomUUID();
      this.db
        .prepare("INSERT INTO persons(id, display_name) VALUES (?, ?)")
        .run(personId, displayName);
      this.db
        .prepare(
          `INSERT INTO identities(id, source, account_id, external_id, display_name, candidate_key, person_id, match_key)
           VALUES (?, 'twitch', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          identityId,
          accountId,
          userId,
          displayName,
          candidateKey(displayName),
          personId,
          matchKey(displayName),
        );
      this.rememberAlias(identityId, displayName, atMs);
      this.db
        .prepare("INSERT INTO membership_operations VALUES (?, ?, ?, ?, ?)")
        .run(
          randomUUID(),
          "owner_bind",
          JSON.stringify([]),
          JSON.stringify([{ id: identityId, personId, how: "owner" }]),
          atMs,
        );
      return personId;
    }).immediate();
  }

  candidatePersons(name: string): string[] {
    // A list for review; this function has no side effects.
    if (!candidateKey(name)) return [];
    return (
      this.db
        .prepare(
          "SELECT DISTINCT i.person_id FROM identities i LEFT JOIN identity_aliases a ON a.identity_id = i.id WHERE i.candidate_key = ? OR a.candidate_key = ? ORDER BY i.person_id",
        )
        .all(candidateKey(name), candidateKey(name)) as { person_id: string }[]
    ).map((row) => row.person_id);
  }

  eventCount(personId?: string): number {
    const row =
      personId === undefined
        ? this.db.prepare("SELECT count(*) AS n FROM events").get()
        : this.db
            .prepare(
              "SELECT count(*) AS n FROM events e JOIN identities i ON i.id = e.identity_id WHERE i.person_id = ?",
            )
            .get(personId);
    return (row as { n: number }).n;
  }

  private rememberAlias(identityId: string, name: string, nowMs: number): void {
    this.db
      .prepare(
        `INSERT INTO identity_aliases VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(identity_id, name) DO UPDATE SET last_seen_ms = excluded.last_seen_ms`,
      )
      .run(identityId, name, candidateKey(name), nowMs, nowMs);
  }

  private assignEvent(id: string, accountId: string, atMs: number): void {
    // v1 has one Twitch channel: known-time DA facts share that channel's session.
    const source = (
      this.db.prepare("SELECT source FROM events WHERE id=?").get(id) as {
        source: string;
      }
    ).source;
    const session = this.db
      .prepare(
        `SELECT id FROM sessions WHERE (account_id = ? OR kind = 'manual' OR ? = 'donationalerts')
      AND started_at_ms <= ? AND (ended_at_ms IS NULL OR ended_at_ms > ?) ORDER BY started_at_ms DESC LIMIT 1`,
      )
      .get(accountId, source, atMs, atMs) as { id: string } | undefined;
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
          "SELECT id, account_id, occurred_at_ms FROM events WHERE (account_id = ? OR source='donationalerts' OR ?='manual') AND occurred_at_ms >= ?",
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
        `DELETE FROM event_sessions WHERE session_id = ? AND event_id IN (SELECT id FROM events WHERE occurred_at_ms >= ?)`,
      )
      .run(id, atMs);
  }

  sessions(): Record<string, unknown>[] {
    const rows = this.db
      .prepare(
        `SELECT s.*,
          (SELECT count(*) FROM event_sessions es WHERE es.session_id=s.id) AS event_count,
          (SELECT title FROM platform_streams p WHERE p.session_id=s.id AND trim(title)<>'' ORDER BY last_observed_at_ms DESC,platform,account_id,external_id LIMIT 1) AS primaryTitle,
          (SELECT json_group_array(platform) FROM (SELECT DISTINCT platform FROM platform_streams p WHERE p.session_id=s.id ORDER BY platform)) AS platforms_json,
          (SELECT json_group_array(json_object('platform',platform,'url',url)) FROM (SELECT DISTINCT platform,url FROM platform_streams p WHERE p.session_id=s.id AND url IS NOT NULL ORDER BY platform,url)) AS urls_json
        FROM sessions s ORDER BY started_at_ms DESC,s.id DESC LIMIT 100`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(({platforms_json, urls_json, ...row}) => ({
      ...row,
      platforms: JSON.parse(platforms_json as string) as string[],
      confirmedUrls: (JSON.parse(urls_json as string) as {platform:"twitch"|"youtube";url:string}[])
        .filter(link=>this.validPlatformStreamUrl(link.platform,link.url)),
    }));
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
        if (confirmed && !this.supersedeProviderLinks(platform, accountId, externalId, startedAtMs, observedAtMs, confirmed)) return null;
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
          sessionId = randomUUID();
          this.db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,NULL,'unknown')")
            .run(sessionId, accountId, streamId, "platform", startedAtMs, observedAtMs);
        }
      }
      this.attachPlatformStreamInTransaction(sessionId, platform, accountId, externalId, startedAtMs, observedAtMs, url, title);
      this.backfillPlatformEvents(sessionId, observedAtMs);
      return sessionId;
    }).immediate();
  }

  private supersedeProviderLinks(
    platform: "twitch" | "youtube", accountId: string, externalId: string,
    startedAtMs: number, observedAtMs: number,
    confirmedPresentIds: string[],
  ): boolean {
    const oldLinks = this.db.prepare(`
      SELECT external_id,session_id,started_at_ms,last_observed_at_ms
      FROM platform_streams
      WHERE platform=? AND account_id=? AND external_id<>? AND ended_at_ms IS NULL
        AND external_id NOT IN (SELECT value FROM json_each(?))
    `).all(platform, accountId, externalId, JSON.stringify(confirmedPresentIds)) as {external_id:string;session_id:string;started_at_ms:number;last_observed_at_ms:number}[];
    if (oldLinks.some(link => observedAtMs <= link.last_observed_at_ms)) return false;
    const affected = new Set<string>();
    for (const link of oldLinks) {
      const endAtMs = Math.max(startedAtMs, link.started_at_ms, link.last_observed_at_ms);
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
      SELECT e.id,? FROM events e JOIN sessions s ON s.id=?
      WHERE e.occurred_at_ms IS NOT NULL
        AND e.occurred_at_ms>=s.recording_started_at_ms AND e.occurred_at_ms<=?
        AND ((e.source='twitch' AND EXISTS (
          SELECT 1 FROM platform_streams ps WHERE ps.session_id=s.id
            AND ps.platform='twitch' AND ps.account_id=e.account_id
        )) OR e.source='donationalerts')
        AND NOT EXISTS (SELECT 1 FROM event_sessions es WHERE es.event_id=e.id)
        AND NOT EXISTS (
          SELECT 1 FROM sessions m WHERE m.kind='manual' AND m.started_at_ms<=e.occurred_at_ms
            AND (m.ended_at_ms IS NULL OR m.ended_at_ms>e.occurred_at_ms)
        )
    `).run(sessionId, sessionId, observedAtMs);
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
          const personId = randomUUID();
          identity = { id: randomUUID() };
          const name=poll.userNames?.[userId] || userId;
          insertPerson.run(personId, name);
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
      }
    }).immediate();
  }

  persons(
    search = "",
    excludedBotLogins: readonly string[] = [],
  ): Record<string, unknown>[] {
    const excluded = this.analyticsExclusions(excludedBotLogins);
    const botJson = JSON.stringify([...excluded]);
    const term = search;
    const key = candidateKey(search);
    // Aggregate counts via JOIN instead of correlated per-row event scans.
    return this.db
      .prepare(
        `SELECT p.id, p.display_name, p.revision,
          coalesce(ec.event_count, 0) AS event_count,
          (SELECT group_concat(DISTINCT i2.source) FROM identities i2 WHERE i2.person_id=p.id) AS sources,
          CASE WHEN EXISTS(
            SELECT 1 FROM identities ib
            WHERE ib.person_id=p.id AND ib.match_key IN (SELECT value FROM json_each(?))
          ) THEN 1 ELSE 0 END AS is_bot
        FROM persons p
        LEFT JOIN (
          SELECT i.person_id, count(e.id) AS event_count
          FROM identities i
          LEFT JOIN events e ON e.identity_id = i.id
          GROUP BY i.person_id
        ) ec ON ec.person_id = p.id
        WHERE EXISTS(SELECT 1 FROM identities i WHERE i.person_id=p.id)
          AND (
            ? = '' OR instr(lower(p.display_name), lower(?)) > 0
            OR EXISTS(
              SELECT 1 FROM identities i
              LEFT JOIN identity_aliases a ON a.identity_id=i.id
              WHERE i.person_id=p.id AND instr(a.candidate_key, ?) > 0
            )
          )
        ORDER BY event_count DESC, p.display_name
        LIMIT 500`,
      )
      .all(botJson, term, term, key) as Record<string, unknown>[];
  }

  person(id: string): Record<string, unknown> {
    const row = this.db.prepare("SELECT * FROM persons WHERE id=?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error("PERSON_NOT_FOUND");
    return {
      ...row,
      identities: this.db
        .prepare("SELECT * FROM identities WHERE person_id=?")
        .all(id),
      aliases: this.db
        .prepare(
          "SELECT a.* FROM identity_aliases a JOIN identities i ON i.id=a.identity_id WHERE i.person_id=?",
        )
        .all(id),
      events: this.events(undefined, id),
    };
  }

  events(
    sessionId?: string,
    personId?: string,
    fromMs?: number,
    toMs?: number,
  ): Record<string, unknown>[] {
    if (fromMs !== undefined) assertTimestamp(fromMs);
    if (toMs !== undefined) assertTimestamp(toMs);
    if (fromMs !== undefined && toMs !== undefined && toMs <= fromMs)
      throw new Error("INVALID_EVENT_WINDOW");
    return this.db
      .prepare(
        `SELECT e.*, i.display_name, i.person_id FROM events e LEFT JOIN identities i ON i.id=e.identity_id
      WHERE (? IS NULL OR e.id IN (SELECT event_id FROM event_sessions WHERE session_id=?)) AND (? IS NULL OR i.person_id=?)
      AND (? IS NULL OR e.occurred_at_ms>=?) AND (? IS NULL OR e.occurred_at_ms<?)
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
      )
      .map((value) => {
        const row = value as Record<string, unknown>;
        return {
          ...row,
          payload: JSON.parse(String(row.payload_json)),
          payload_json: undefined,
        };
      });
  }

  summary(
    sessionId?: string,
    excludedBotLogins: readonly string[] = [],
  ): Record<string, unknown> {
    const excluded = this.analyticsExclusions(excludedBotLogins);
    const botKeys = [...excluded];
    const botJson = JSON.stringify(botKeys);
    const sid = sessionId ?? null;
    const inSession =
      "(? IS NULL OR e.id IN (SELECT event_id FROM event_sessions WHERE session_id=?))";
    // SQL aggregates — avoid loading/parsing every event row in JS.
    const counts = this.db
      .prepare(
        `SELECT
        (SELECT count(*) FROM events e WHERE ${inSession}) AS event_count,
        (SELECT count(*) FROM events e
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
        (SELECT count(*) FROM events e LEFT JOIN identities i ON i.id=e.identity_id WHERE ${inSession} AND e.type = 'donation' AND (i.id IS NULL OR i.match_key NOT IN(SELECT value FROM json_each(?)))) AS donations`,
      )
      .get(sid, sid, sid, sid, botJson, sid, sid, botJson) as {
      event_count: number;
      messages: number;
      donations: number;
    };
    const donationRows = this.db
      .prepare(
        `SELECT json_extract(e.payload_json, '$.currency') AS currency,
                json_extract(e.payload_json, '$.amountMinor') AS amount_minor
         FROM events e LEFT JOIN identities i ON i.id=e.identity_id
         WHERE ${inSession} AND e.type = 'donation' AND (i.id IS NULL OR i.match_key NOT IN(SELECT value FROM json_each(?)))
           AND json_extract(e.payload_json, '$.currency') IS NOT NULL
           AND json_extract(e.payload_json, '$.amountMinor') IS NOT NULL`,
      )
      .all(sid, sid, botJson) as { currency: string; amount_minor: string }[];
    const totals: Record<string, string> = {};
    for (const row of donationRows) {
      totals[row.currency] = (
        BigInt(totals[row.currency] ?? "0") + BigInt(row.amount_minor)
      ).toString();
    }
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
          (SELECT count(DISTINCT i.person_id) FROM events e
            JOIN identities i ON i.id = e.identity_id
            WHERE ${inSession}
              AND i.match_key NOT IN (SELECT value FROM json_each(?))
          ) AS unique_persons_events,
          (SELECT count(DISTINCT i.id) FROM events e
            JOIN identities i ON i.id = e.identity_id
            WHERE ${inSession}
              AND i.match_key NOT IN (SELECT value FROM json_each(?))
          ) AS unique_identities_events`,
      )
      .get(sid, sid, botJson, sid, sid, botJson) as {
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
        sessionDurationMs = Math.max(0, endMs - session.started_at_ms);
        const durationMin = sessionDurationMs / 60_000;
        messagesPerMinuteOfSession =
          durationMin > 0
            ? Math.round((counts.messages / durationMin) * 1000) / 1000
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
             ORDER BY p.completed_at_ms ASC LIMIT 200`,
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
    return {
      messages: counts.messages,
      donations: counts.donations,
      totals,
      chatters,
      lastPollAtMs: latest?.completed_at_ms ?? null,
      events: counts.event_count,
      excludedBots: botKeys.length,
      uniquePersons: unique.unique_persons_events,
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
    return presenceMinutes(normalized, personId, fromMs, toMs);
  }


  /** Lower bound for clear / clear-user: open session start, else 6h window. */
  private moderationScope(accountId: string, atMs: number): number {
    const session = this.db
      .prepare(
        `SELECT started_at_ms FROM sessions
         WHERE account_id=? AND started_at_ms<=? AND (ended_at_ms IS NULL OR ended_at_ms>?)
         ORDER BY started_at_ms DESC LIMIT 1`,
      )
      .get(accountId, atMs, atMs) as { started_at_ms: number } | undefined;
    if (session) return session.started_at_ms;
    return Math.max(0, atMs - 6 * 3_600_000);
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

  splitIdentities(
    ids: string[],
    name: string,
    sourceRevision: number,
    nowMs: number,
  ): string {
    assertTimestamp(nowMs);
    if (
      !ids.length ||
      new Set(ids).size !== ids.length ||
      !name.trim() ||
      name.length > 200
    )
      throw new Error("INVALID_SPLIT");
    return this.db.transaction(() => {
      const all = this.db
        .prepare(
          `SELECT id, person_id AS personId FROM identities WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`,
        )
        .all(...ids) as Membership[];
      if (
        all.length !== ids.length ||
        new Set(all.map((row) => row.personId)).size !== 1
      )
        throw new Error("INVALID_SPLIT");
      const source = all[0]!.personId;
      if (this.personRevision(source) !== sourceRevision)
        throw new Error("REVISION_CONFLICT");
      const target = randomUUID();
      this.db
        .prepare("INSERT INTO persons VALUES (?, ?, 1)")
        .run(target, name.trim());
      for (const identity of all)
        this.db
          .prepare("UPDATE identities SET person_id=? WHERE id=?")
          .run(target, identity.id);
      this.db
        .prepare("UPDATE persons SET revision=revision+1 WHERE id=?")
        .run(source);
      this.db
        .prepare("INSERT INTO membership_operations VALUES (?, ?, ?, ?, ?)")
        .run(
          randomUUID(),
          "split",
          JSON.stringify(all),
          JSON.stringify(all.map((row) => ({ ...row, personId: target }))),
          nowMs,
        );
      return target;
    }).immediate();
  }

  merges(): Record<string, unknown>[] {
    return this.db
      .prepare(
        "SELECT id, source_person_id, target_person_id, created_at_ms, undone_at_ms FROM person_merges ORDER BY created_at_ms DESC LIMIT 100",
      )
      .all() as Record<string, unknown>[];
  }


  private sessionRow(sessionId: string): {
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
    const totalMinutes = Math.max(0, (toMs - fromMs) / 60_000);
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
        known.add(minute);
    return {
      knownMinutes: known.size,
      totalMinutes,
      ratio: totalMinutes > 0 ? Math.round((known.size / totalMinutes) * 1000) / 1000 : null,
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
    const observed = new Set<number>();
    for (const poll of polls)
      for (const minute of pollCoveredMinutes(
        poll.started_at_ms,
        poll.completed_at_ms,
        fromMs,
        toMs,
      ))
        observed.add(minute);
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

  private analyticsExclusions(excludedBotLogins: readonly string[] = []): ReadonlySet<string> {
    const keys=new Set(botExclusionSet(["fullrandomname_twitch",...excludedBotLogins]));
    const json=JSON.stringify([...keys]);
    const rows=this.db.prepare(`SELECT DISTINCT linked.match_key FROM identities linked WHERE EXISTS(
      SELECT 1 FROM identities i WHERE i.person_id=linked.person_id AND (
        i.match_key IN(SELECT value FROM json_each(?)) OR (i.source='twitch' AND i.external_id=i.account_id) OR
        EXISTS(SELECT 1 FROM identity_aliases a WHERE a.identity_id=i.id AND ltrim(a.candidate_key,'@#') IN(SELECT value FROM json_each(?)))
      ))`).all(json,json) as {match_key:string}[];
    for(const row of rows)keys.add(row.match_key);
    return keys;
  }
  private botJson(excludedBotLogins: readonly string[] = []): string {
    return JSON.stringify([...this.analyticsExclusions(excludedBotLogins)]);
  }

  private notBotClause(alias = "i"): string {
    return `${alias}.match_key NOT IN (SELECT value FROM json_each(?))`;
  }

  personStats(
    personId: string,
    sessionId?: string,
    excludedBotLogins: readonly string[] = [],
  ): Record<string, unknown> {
    const person = this.db
      .prepare("SELECT id, display_name FROM persons WHERE id=?")
      .get(personId) as { id: string; display_name: string } | undefined;
    if (!person) throw new Error("PERSON_NOT_FOUND");
    const botJson = this.botJson(excludedBotLogins);
    const sid = sessionId ?? null;
    const inSession =
      "(? IS NULL OR e.id IN (SELECT event_id FROM event_sessions WHERE session_id=?))";
    const messageCount = (
      this.db
        .prepare(
          `SELECT count(*) AS n FROM events e
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
         FROM events e
         JOIN identities i ON i.id = e.identity_id
         WHERE i.person_id = ? AND ${inSession} AND e.type = 'donation'
           AND json_extract(e.payload_json, '$.currency') IS NOT NULL
           AND json_extract(e.payload_json, '$.amountMinor') IS NOT NULL`,
      )
      .all(personId, sid, sid) as { currency: string; amount_minor: string }[];
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
         FROM events e
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
           WHERE i.person_id = ? AND p.status = 'complete'`,
        )
        .get(personId) as { first_ms: number | null; last_ms: number | null };
      firstObservedMs = bounds.first_ms;
      lastObservedMs = bounds.last_ms;
    }
    const sessions = this.db
      .prepare(
        `SELECT id, started_at_ms, ended_at_ms FROM sessions
         ORDER BY started_at_ms DESC LIMIT 50`,
      )
      .all() as {
      id: string;
      started_at_ms: number;
      ended_at_ms: number | null;
    }[];
    let observedSum = 0;
    let observedSessions = 0;
    let offsetSum = 0;
    let offsetSessions = 0;
    for (const session of sessions) {
      const fromMs = Math.floor(session.started_at_ms / 60_000) * 60_000;
      const endMs = session.ended_at_ms ?? Date.now();
      let toMs = Math.ceil(endMs / 60_000) * 60_000;
      if (toMs - fromMs > 31 * 86_400_000) continue;
      if (toMs <= fromMs) continue;
      const obs = this.observedMinutesForPerson(
        session.id,
        personId,
        fromMs,
        toMs,
      );
      if (obs.observedMinutes > 0) {
        observedSum += obs.observedMinutes;
        observedSessions += 1;
        if (obs.firstObservedMs !== null) {
          offsetSum += Math.max(0, obs.firstObservedMs - session.started_at_ms);
          offsetSessions += 1;
        }
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
      firstObservedMs,
      lastObservedMs,
      observedMinutesThisSession,
      avgObservedMinutes:
        observedSessions > 0
          ? Math.round((observedSum / observedSessions) * 1000) / 1000
          : null,
      avgFirstObservedOffsetMs:
        offsetSessions > 0
          ? Math.round(offsetSum / offsetSessions)
          : null,
      sessionsWithObservation: observedSessions,
    };
  }

  personsTop(
    sortBy: "messages" | "donations" | "observed_minutes" = "messages",
    sessionId?: string,
    excludedBotLogins: readonly string[] = [],
    limit = 50,
  ): Record<string, unknown>[] {
    if (!["messages", "donations", "observed_minutes"].includes(sortBy))
      throw new Error("INVALID_SORT");
    const capped = Math.min(Math.max(1, Math.floor(limit) || 50), 100);
    const botJson = this.botJson(excludedBotLogins);
    const sid = sessionId ?? null;
    const inSession =
      "(? IS NULL OR e.id IN (SELECT event_id FROM event_sessions WHERE session_id=?))";
    if (sortBy === "observed_minutes") {
      if (!sessionId) {
        // All-time: sum observed minutes across recent sessions is expensive;
        // rank by distinct complete polls instead as a proxy, then attach minutes for top candidates.
        const rows = this.db
          .prepare(
            `SELECT p.id, p.display_name, p.revision,
               (SELECT group_concat(DISTINCT i2.source) FROM identities i2 WHERE i2.person_id=p.id) AS sources,
               count(DISTINCT poll.id) AS poll_count
             FROM persons p
             JOIN identities i ON i.person_id = p.id
             JOIN presence_members m ON m.identity_id = i.id
             JOIN presence_polls poll ON poll.id = m.poll_id AND poll.status='complete'
             WHERE ${this.notBotClause("i")}
             GROUP BY p.id
             ORDER BY poll_count DESC, p.display_name
             LIMIT ?`,
          )
          .all(botJson, capped) as Record<string, unknown>[];
        return rows.map((row) => {
          const sessions = this.db
            .prepare(
              `SELECT DISTINCT poll.session_id AS id FROM presence_polls poll
               JOIN presence_members m ON m.poll_id = poll.id
               JOIN identities i ON i.id = m.identity_id
               WHERE i.person_id = ? AND poll.status='complete'
               LIMIT 20`,
            )
            .all(row.id) as { id: string }[];
          let minutes = 0;
          for (const s of sessions) {
            try {
              const w = this.sessionMinuteWindow(s.id);
              minutes += this.observedMinutesForPerson(
                s.id,
                String(row.id),
                w.fromMs,
                w.toMs,
              ).observedMinutes;
            } catch {
              /* skip missing */
            }
          }
          return {
            id: row.id,
            display_name: row.display_name,
            revision: row.revision,
            sources: row.sources,
            messageCount: 0,
            donationCount: 0,
            donationTotals: {},
            observedMinutes: minutes,
          };
        }).sort((a, b) => (b.observedMinutes as number) - (a.observedMinutes as number));
      }
      const window = this.sessionMinuteWindow(sessionId);
      const candidates = this.db
        .prepare(
          `SELECT DISTINCT p.id, p.display_name, p.revision,
             (SELECT group_concat(DISTINCT i2.source) FROM identities i2 WHERE i2.person_id=p.id) AS sources
           FROM persons p
           JOIN identities i ON i.person_id = p.id
           JOIN presence_members m ON m.identity_id = i.id
           JOIN presence_polls poll ON poll.id = m.poll_id
           WHERE poll.session_id = ? AND poll.status = 'complete'
             AND ${this.notBotClause("i")}`,
        )
        .all(sessionId, botJson) as Record<string, unknown>[];
      return candidates
        .map((row) => {
          const obs = this.observedMinutesForPerson(
            sessionId,
            String(row.id),
            window.fromMs,
            window.toMs,
          );
          return {
            id: row.id,
            display_name: row.display_name,
            revision: row.revision,
            sources: row.sources,
            messageCount: 0,
            donationCount: 0,
            donationTotals: {},
            observedMinutes: obs.observedMinutes,
          };
        })
        .filter((row) => row.observedMinutes > 0)
        .sort((a, b) => b.observedMinutes - a.observedMinutes)
        .slice(0, capped);
    }

    const typeFilter =
      sortBy === "messages"
        ? `e.type = 'chat.message'
             AND (
               json_extract(e.payload_json, '$.originChannelId') IS NULL
               OR json_extract(e.payload_json, '$.originChannelId') = e.account_id
             )`
        : `e.type = 'donation'`;
    const rows = this.db
      .prepare(
        `SELECT p.id, p.display_name, p.revision,
           (SELECT group_concat(DISTINCT i2.source) FROM identities i2 WHERE i2.person_id=p.id) AS sources,
           count(e.id) AS metric_count
         FROM persons p
         JOIN identities i ON i.person_id = p.id
         JOIN events e ON e.identity_id = i.id
         WHERE ${inSession} AND ${typeFilter}
           AND ${this.notBotClause("i")}
         GROUP BY p.id
         ORDER BY metric_count DESC, p.display_name
         LIMIT ?`,
      )
      .all(sid, sid, botJson, capped) as Record<string, unknown>[];

    return rows.map((row) => {
      const donationRows = this.db
        .prepare(
          `SELECT json_extract(e.payload_json, '$.currency') AS currency,
                  json_extract(e.payload_json, '$.amountMinor') AS amount_minor
           FROM events e
           JOIN identities i ON i.id = e.identity_id
           WHERE i.person_id = ? AND ${inSession} AND e.type = 'donation'
             AND json_extract(e.payload_json, '$.currency') IS NOT NULL
             AND json_extract(e.payload_json, '$.amountMinor') IS NOT NULL`,
        )
        .all(row.id, sid, sid) as { currency: string; amount_minor: string }[];
      const donationTotals: Record<string, string> = {};
      for (const d of donationRows) {
        donationTotals[d.currency] = (
          BigInt(donationTotals[d.currency] ?? "0") + BigInt(d.amount_minor)
        ).toString();
      }
      const messageCount =
        sortBy === "messages"
          ? Number(row.metric_count)
          : (
              this.db
                .prepare(
                  `SELECT count(*) AS n FROM events e
                   JOIN identities i ON i.id = e.identity_id
                   WHERE i.person_id = ? AND ${inSession}
                     AND e.type = 'chat.message'
                     AND (
                       json_extract(e.payload_json, '$.originChannelId') IS NULL
                       OR json_extract(e.payload_json, '$.originChannelId') = e.account_id
                     )
                     AND ${this.notBotClause("i")}`,
                )
                .get(row.id, sid, sid, botJson) as { n: number }
            ).n;
      let observedMinutes = 0;
      if (sessionId) {
        try {
          const w = this.sessionMinuteWindow(sessionId);
          observedMinutes = this.observedMinutesForPerson(
            sessionId,
            String(row.id),
            w.fromMs,
            w.toMs,
          ).observedMinutes;
        } catch {
          observedMinutes = 0;
        }
      }
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
         FROM events e
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
           SELECT 1 FROM events e
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

    // First-timers this session
    const sessionPeople = this.db
      .prepare(
        `SELECT DISTINCT i.person_id AS id, p.display_name FROM identities i
         JOIN persons p ON p.id = i.person_id
         WHERE ${this.notBotClause("i")} AND (
           EXISTS(
             SELECT 1 FROM events e WHERE e.identity_id = i.id AND ${inSession}
           ) OR EXISTS(
             SELECT 1 FROM presence_members m
             JOIN presence_polls poll ON poll.id = m.poll_id
             WHERE m.identity_id = i.id AND poll.session_id = ? AND poll.status='complete'
           )
         )`,
      )
      .all(botJson, sid, sid) as { id: string; display_name: string }[];
    for (const person of sessionPeople) {
      const prior = this.db
        .prepare(
          `SELECT 1 AS ok WHERE EXISTS(
             SELECT 1 FROM events e
             JOIN identities i ON i.id = e.identity_id
             WHERE i.person_id = ? AND e.id NOT IN (
               SELECT event_id FROM event_sessions WHERE session_id = ?
             )
           ) OR EXISTS(
             SELECT 1 FROM presence_members m
             JOIN presence_polls poll ON poll.id = m.poll_id
             JOIN identities i ON i.id = m.identity_id
             WHERE i.person_id = ? AND poll.session_id != ? AND poll.status='complete'
           )`,
        )
        .get(person.id, sid, person.id, sid) as { ok: number } | undefined;
      if (!prior) {
        cards.push({
          kind: "first_timer",
          title: "Впервые в этой сессии",
          detail: `${person.display_name}: нет более ранних событий или наблюдений`,
          personId: person.id,
          sessionId: sid,
          metrics: {},
        });
      }
    }

    // Coverage holes / gaps
    const cov = this.sessionCoverage(sid, window.fromMs, window.toMs);
    if (cov.ratio !== null && cov.ratio < 0.7 && cov.totalMinutes >= 10) {
      cards.push({
        kind: "coverage_hole",
        title: "Дыры в опросах присутствия",
        detail: `Покрытие сессии: ${Math.round(cov.ratio * 100)}% (${cov.knownMinutes}/${cov.totalMinutes} мин)`,
        personId: null,
        sessionId: sid,
        metrics: cov,
      });
    }
    const gaps = this.db
      .prepare(
        `SELECT id, source, reason, started_at_ms, ended_at_ms FROM collection_gaps
         WHERE started_at_ms < ? AND (ended_at_ms IS NULL OR ended_at_ms > ?)
         ORDER BY started_at_ms DESC LIMIT 5`,
      )
      .all(window.toMs, focus.started_at_ms) as Record<string, unknown>[];
    if (gaps.length) {
      cards.push({
        kind: "collection_gaps",
        title: "Пропуски сбора",
        detail: `${gaps.length} записей collection_gaps пересекают сессию`,
        personId: null,
        sessionId: sid,
        metrics: { count: gaps.length, gaps },
      });
    }

    // Returning after long gap (>= 14 days since prior activity)
    const fourteen = 14 * 86_400_000;
    for (const person of sessionPeople) {
      const priorLast = this.db
        .prepare(
          `SELECT max(ts) AS last_ms FROM (
             SELECT coalesce(e.occurred_at_ms, e.received_at_ms) AS ts
             FROM events e JOIN identities i ON i.id = e.identity_id
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
