import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  candidateKey,
  matchKey,
  eventKey,
  assertTimestamp,
  type EventInput,
  type Source,
} from "./domain.js";
import { schemaV1, schemaV2, schemaV3 } from "./schema.js";
import { botExclusionSet } from "./bots.js";
import { presenceMinutes, type PresencePoll } from "./presence.js";

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

  constructor(path: string) {
    this.db = new Database(path);
    try {
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 5000");
      const version = this.db.pragma("user_version", { simple: true });
      if (version !== 0 && version !== 1 && version !== 2 && version !== 3)
        throw new Error("UNSUPPORTED_SCHEMA_VERSION");
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      if (version === 0) this.db.transaction(() => this.db.exec(schemaV1))();
      if ((this.db.pragma("user_version", { simple: true }) as number) < 2)
        this.db.transaction(() => this.db.exec(schemaV2))();
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
        })();
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
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
    if (
      event.source === "donationalerts" &&
      event.actor &&
      event.actor.externalId !== event.externalId
    ) {
      throw new Error("DA_ACTOR_MUST_BE_DONATION_OCCURRENCE");
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
        if (!identity) {
          newIdentity = true;
          const linked = this.resolveAutoLinkPerson(
            event.source,
            event.accountId,
            event.actor.externalId,
            event.actor.displayName,
          );
          const personId = linked ?? randomUUID();
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
                    how:
                      event.source === "twitch" &&
                      event.actor.externalId === event.accountId
                        ? "owner"
                        : "login_match",
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
    })();
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
    })();
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
    })();
  }


  /**
   * High-confidence auto-link target person id, or null.
   * Exact platform id is handled by caller lookup. Strong name: unique
   * cross-source match_key (exactly one person). Owner person is created via
   * ensureOwnerIdentity so DA donations matching the owner login link here.
   */
  private resolveAutoLinkPerson(
    source: Source,
    _accountId: string,
    _externalId: string,
    displayName: string,
  ): string | null {
    const key = matchKey(displayName);
    if (!key) return null;
    const other = source === "twitch" ? "donationalerts" : "twitch";
    const rows = this.db
      .prepare(
        `SELECT DISTINCT person_id FROM identities
         WHERE source = ? AND match_key = ?`,
      )
      .all(other, key) as { person_id: string }[];
    if (rows.length === 1) return rows[0]!.person_id;
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
    })();
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
      if (prior) return prior.id;
      this.db
        .prepare(
          "UPDATE sessions SET ended_at_ms = ?, end_quality = 'estimated' WHERE account_id = ? AND ended_at_ms IS NULL",
        )
        .run(startedAtMs, accountId);
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, NULL, 'unknown')",
        )
        .run(id, accountId, streamId, kind, startedAtMs, nowMs);
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
    })();
  }

  endSession(id: string, atMs: number, quality = "observed"): void {
    assertTimestamp(atMs);
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE sessions SET ended_at_ms = ?, end_quality = ? WHERE id = ? AND ended_at_ms IS NULL AND started_at_ms <= ?",
        )
        .run(atMs, quality, id, atMs);
      this.db
        .prepare(
          `DELETE FROM event_sessions WHERE session_id = ? AND event_id IN (SELECT id FROM events WHERE occurred_at_ms >= ?)`,
        )
        .run(id, atMs);
    })();
  }

  sessions(): Record<string, unknown>[] {
    return this.db
      .prepare(
        `SELECT s.*, (SELECT count(*) FROM event_sessions e WHERE e.session_id=s.id) event_count
      FROM sessions s ORDER BY started_at_ms DESC LIMIT 100`,
      )
      .all() as Record<string, unknown>[];
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
          insertPerson.run(personId, userId);
          insertIdentity.run(
            identity.id,
            accountId,
            userId,
            userId,
            candidateKey(userId),
            personId,
            matchKey(userId),
          );
        }
        insertMember.run(id, identity.id);
      }
    })();
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
    })();
  }

  persons(
    search = "",
    excludedBotLogins: readonly string[] = [],
  ): Record<string, unknown>[] {
    const excluded = botExclusionSet(excludedBotLogins);
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
    const excluded = botExclusionSet(excludedBotLogins);
    const botKeys = [...excluded];
    const botJson = JSON.stringify(botKeys);
    const sid = sessionId ?? null;
    const inSession =
      "(? IS NULL OR e.id IN (SELECT event_id FROM event_sessions WHERE session_id=?))";
    // SQL aggregates — avoid loading/parsing every event row in JS.
    const counts = this.db
      .prepare(
        `SELECT
        (SELECT count(*) FROM events e WHERE ${inSession}) AS events,
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
        (SELECT count(*) FROM events e WHERE ${inSession} AND e.type = 'donation') AS donations`,
      )
      .get(sid, sid, sid, sid, botJson, sid, sid) as {
      events: number;
      messages: number;
      donations: number;
    };
    const donationRows = this.db
      .prepare(
        `SELECT json_extract(e.payload_json, '$.currency') AS currency,
                json_extract(e.payload_json, '$.amountMinor') AS amount_minor
         FROM events e
         WHERE ${inSession} AND e.type = 'donation'
           AND json_extract(e.payload_json, '$.currency') IS NOT NULL
           AND json_extract(e.payload_json, '$.amountMinor') IS NOT NULL`,
      )
      .all(sid, sid) as { currency: string; amount_minor: string }[];
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
    return {
      messages: counts.messages,
      donations: counts.donations,
      totals,
      chatters,
      lastPollAtMs: latest?.completed_at_ms ?? null,
      events: counts.events,
      excludedBots: botKeys.length,
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
    })();
  }

  merges(): Record<string, unknown>[] {
    return this.db
      .prepare(
        "SELECT id, source_person_id, target_person_id, created_at_ms, undone_at_ms FROM person_merges ORDER BY created_at_ms DESC LIMIT 100",
      )
      .all() as Record<string, unknown>[];
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
        snapshot.pragma("user_version", { simple: true }) !== 3
      )
        throw new Error("BACKUP_VALIDATION_FAILED");
    } finally {
      snapshot.close();
    }
  }
}
