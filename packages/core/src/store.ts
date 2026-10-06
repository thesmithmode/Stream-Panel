import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  candidateKey,
  eventKey,
  assertTimestamp,
  type EventInput,
} from "./domain.js";
import { schemaV1, schemaV2 } from "./schema.js";
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

export class StreamStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    try {
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 5000");
      const version = this.db.pragma("user_version", { simple: true });
      if (version !== 0 && version !== 1 && version !== 2)
        throw new Error("UNSUPPORTED_SCHEMA_VERSION");
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      if (version === 0) this.db.transaction(() => this.db.exec(schemaV1))();
      if (version !== 2) this.db.transaction(() => this.db.exec(schemaV2))();
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
          identity = { id: randomUUID(), person_id: randomUUID() };
          this.db
            .prepare("INSERT INTO persons(id, display_name) VALUES (?, ?)")
            .run(identity.person_id, event.actor.displayName);
          this.db
            .prepare(
              `INSERT INTO identities(id, source, account_id, external_id, display_name, candidate_key, person_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              identity.id,
              event.source,
              event.accountId,
              event.actor.externalId,
              event.actor.displayName,
              candidateKey(event.actor.displayName),
              identity.person_id,
            );
        } else {
          this.db
            .prepare(
              "UPDATE identities SET display_name = ?, candidate_key = ? WHERE id = ?",
            )
            .run(
              event.actor.displayName,
              candidateKey(event.actor.displayName),
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
        if (event.type === "chat.clear")
          this.db
            .prepare(
              "UPDATE events SET payload_json=json_set(payload_json, '$.text', '[сообщение удалено]', '$.redacted', 1) WHERE source='twitch' AND account_id=? AND type='chat.message'",
            )
            .run(event.accountId);
        else if (event.type === "chat.message_delete" && messageId)
          this.db
            .prepare(
              "UPDATE events SET payload_json=json_set(payload_json, '$.text', '[сообщение удалено]', '$.redacted', 1) WHERE source='twitch' AND account_id=? AND type='chat.message' AND external_id=?",
            )
            .run(event.accountId, messageId);
        else if (event.type === "chat.clear_user_messages" && userId)
          this.db
            .prepare(
              "UPDATE events SET payload_json=json_set(payload_json, '$.text', '[сообщение удалено]', '$.redacted', 1) WHERE source='twitch' AND account_id=? AND type='chat.message' AND identity_id IN(SELECT id FROM identities WHERE source='twitch' AND account_id=? AND external_id=?)",
            )
            .run(event.accountId, event.accountId, userId);
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
      if (identity && newIdentity)
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
      for (const userId of new Set(poll.userIds)) {
        let identity = this.db
          .prepare(
            "SELECT id FROM identities WHERE source='twitch' AND account_id=? AND external_id=?",
          )
          .get(accountId, userId) as { id: string } | undefined;
        if (!identity) {
          const personId = randomUUID();
          identity = { id: randomUUID() };
          this.db
            .prepare("INSERT INTO persons VALUES (?, ?, 1)")
            .run(personId, userId);
          this.db
            .prepare(
              "INSERT INTO identities VALUES (?, 'twitch', ?, ?, ?, ?, ?)",
            )
            .run(identity.id, accountId, userId, userId, userId, personId);
        }
        this.db
          .prepare("INSERT INTO presence_members VALUES (?, ?)")
          .run(id, identity.id);
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
            "UPDATE identities SET display_name=?, candidate_key=? WHERE id=?",
          )
          .run(user.user_name, candidateKey(user.user_name), identity.id);
        this.db
          .prepare(
            "UPDATE persons SET display_name=? WHERE id=? AND display_name=?",
          )
          .run(user.user_name, identity.person_id, identity.display_name);
        this.rememberAlias(identity.id, user.user_name, atMs);
      }
    })();
  }

  persons(search = ""): Record<string, unknown>[] {
    return this.db
      .prepare(
        `SELECT p.*, (SELECT count(*) FROM events e JOIN identities i ON e.identity_id=i.id WHERE i.person_id=p.id) event_count,
      (SELECT group_concat(DISTINCT i.source) FROM identities i WHERE i.person_id=p.id) sources
      FROM persons p WHERE EXISTS(SELECT 1 FROM identities i WHERE i.person_id=p.id)
      AND (instr(lower(p.display_name), lower(?)) > 0 OR EXISTS(SELECT 1 FROM identities i LEFT JOIN identity_aliases a ON a.identity_id=i.id WHERE i.person_id=p.id AND instr(a.candidate_key, ?) > 0))
      ORDER BY event_count DESC, p.display_name LIMIT 500`,
      )
      .all(search, candidateKey(search)) as Record<string, unknown>[];
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

  summary(sessionId?: string): Record<string, unknown> {
    const where =
      "(? IS NULL OR e.id IN (SELECT event_id FROM event_sessions WHERE session_id=?))";
    const rows = this.db
      .prepare(
        `SELECT e.type, e.payload_json, e.account_id FROM events e WHERE ${where}`,
      )
      .all(sessionId ?? null, sessionId ?? null) as {
      type: string;
      payload_json: string;
      account_id: string;
    }[];
    let messages = 0;
    let donations = 0;
    const totals: Record<string, string> = {};
    for (const row of rows) {
      if (row.type === "chat.message") {
        const payload = JSON.parse(row.payload_json) as {
          originChannelId?: string;
        };
        if (
          !payload.originChannelId ||
          payload.originChannelId === row.account_id
        )
          messages++;
      }
      if (row.type === "donation") {
        donations++;
        const payload = JSON.parse(row.payload_json) as {
          amountMinor?: string;
          currency?: string;
        };
        if (payload.amountMinor && payload.currency)
          totals[payload.currency] = (
            BigInt(totals[payload.currency] ?? "0") +
            BigInt(payload.amountMinor)
          ).toString();
      }
    }
    const latest = this.db
      .prepare(
        `SELECT p.* FROM presence_polls p WHERE p.status='complete' AND (? IS NULL OR p.session_id=?) ORDER BY p.completed_at_ms DESC LIMIT 1`,
      )
      .get(sessionId ?? null, sessionId ?? null) as
      | { id: string; completed_at_ms: number }
      | undefined;
    const chatters = latest
      ? (
          this.db
            .prepare("SELECT count(*) n FROM presence_members WHERE poll_id=?")
            .get(latest.id) as { n: number }
        ).n
      : null;
    return {
      messages,
      donations,
      totals,
      chatters,
      lastPollAtMs: latest?.completed_at_ms ?? null,
      events: rows.length,
    };
  }

  grid(
    sessionId: string,
    personId: string,
    fromMs: number,
    toMs: number,
  ): ReturnType<typeof presenceMinutes> {
    const polls = this.db
      .prepare(
        `SELECT p.* FROM presence_polls p WHERE session_id=? AND completed_at_ms >= ? AND completed_at_ms < ? ORDER BY completed_at_ms`,
      )
      .all(sessionId, fromMs, toMs) as {
      id: string;
      started_at_ms: number;
      completed_at_ms: number;
      status: PresencePoll["status"];
    }[];
    const normalized = polls.map((poll) => ({
      startedAtMs: poll.started_at_ms,
      completedAtMs: poll.completed_at_ms,
      status: poll.status,
      userIds: (
        this.db
          .prepare(
            "SELECT i.person_id FROM presence_members m JOIN identities i ON i.id=m.identity_id WHERE m.poll_id=? AND i.person_id=?",
          )
          .all(poll.id, personId) as { person_id: string }[]
      ).map((row) => row.person_id),
    }));
    return presenceMinutes(normalized, personId, fromMs, toMs);
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
        snapshot.pragma("user_version", { simple: true }) !== 2
      )
        throw new Error("BACKUP_VALIDATION_FAILED");
    } finally {
      snapshot.close();
    }
  }
}
