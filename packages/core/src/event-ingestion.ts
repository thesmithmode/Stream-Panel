import {SubscriberHistory} from './subscriber-history.js';
import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {assertTimestamp,candidateKey,matchKey,daDonorExternalId,eventKey,type EventInput} from './domain.js';
import {chatMetadata,moderationMetadata} from './message-storage.js';
import {DonationLedger} from './donations.js';
import {ProviderStorage} from './provider-storage.js';
import {RecentEvents} from './recent-events.js';
import type {IdentityLinks} from './identity-links.js';
import type {StreamSessions} from './stream-sessions.js';
interface IdentityRow {id:string;person_id:string}

export const priorModerationQuery = `SELECT 1 FROM events WHERE source='twitch' AND account_id=?
        AND type IN ('chat.message_delete','chat.clear','chat.clear_user_messages') AND (
          (type='chat.message_delete' AND json_extract(payload_json,'$.targetMessageId')=?) OR
          (occurred_at_ms>=? AND (type='chat.clear' OR
          (type='chat.clear_user_messages' AND json_extract(payload_json,'$.targetUserId')=?)))) LIMIT 1`;

/** Validates and atomically records deduplicated facts; collaborators share this connection. */
export class EventIngestion {
  constructor(private readonly db:Database.Database,
    private readonly links:Pick<IdentityLinks,'resolveAutoLinkPerson'|'rememberAlias'>,
    private readonly streams:Pick<StreamSessions,'assignEvent'|'activeLogicalStream'>) {}

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
    if(event.source==='twitch'&&!['chat.message','chat.message_delete','chat.clear','chat.clear_user_messages','channel.update','follow','subscription','subscription.gift','subscription.message','raid','bits'].includes(event.type))
      return {inserted:false,identityId:null,personId:null};
    JSON.stringify(event.payload); // Validate before writes; permanent chat facts remain content-free.
    const payload = JSON.stringify(event.type === "chat.message" ? chatMetadata(event.payload) :
      ["chat.message_delete","chat.clear","chat.clear_user_messages"].includes(event.type) ? moderationMetadata(event.payload) : event.payload);
    return this.db.transaction(() => {
      if(event.source==='twitch'&&event.type==='follow'&&event.actor&&event.occurredAtMs!==null)new SubscriberHistory(this.db).follow(event.accountId,event.actor.externalId,event.actor.displayName,event.occurredAtMs);
      const previous = this.db
        .prepare(`SELECT identity_id AS id FROM events WHERE id = ?`)
        .get(eventKey(event)) as { id: string | null } | undefined;
      if (previous) {
        if(event.source==='donationalerts'&&event.type==='donation')new ProviderStorage(this.db).clearImported(event.accountId,event.externalId);
        // A REST rescan can supply the configured time missing at first reception.
        // Preserve the original payload, donor and every explicit correction.
        if(event.source==='donationalerts' && event.type==='donation' && event.occurredAtMs!==null){
          const repaired=this.db.prepare("UPDATE events SET occurred_at_ms=?,time_quality=?,source_time=coalesce(?,source_time) WHERE id=? AND occurred_at_ms IS NULL").run(event.occurredAtMs,event.timeQuality,event.sourceTime,eventKey(event));
          if(repaired.changes){
            this.db.prepare("UPDATE donation_corrections SET occurred_at_ms=? WHERE event_id=? AND occurred_at_ms IS NULL AND coalesce(json_extract(payload_json,'$.corrected'),0)=0").run(event.occurredAtMs,eventKey(event));
            const effective=this.db.prepare('SELECT occurred_at_ms FROM effective_events WHERE id=?').get(eventKey(event)) as {occurred_at_ms:number|null}|undefined;
            this.db.prepare('DELETE FROM event_sessions WHERE event_id=?').run(eventKey(event));
            if(effective?.occurred_at_ms!=null)this.streams.assignEvent(eventKey(event),event.accountId,effective.occurred_at_ms);
          }
        }
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
      if(event.type==='follow' && event.actor && event.occurredAtMs!==null){
        const second=Math.floor(event.occurredAtMs/1000)*1000;
        const duplicate=this.db.prepare(`SELECT i.id,i.person_id FROM events e JOIN identities i ON i.id=e.identity_id
          WHERE e.source=? AND e.account_id=? AND e.type='follow' AND i.external_id=?
            AND e.occurred_at_ms>=? AND e.occurred_at_ms<? LIMIT 1`).get(event.source,event.accountId,event.actor.externalId,second,second+1000) as IdentityRow|undefined;
        if(duplicate)return {inserted:false,identityId:duplicate.id,personId:duplicate.person_id};
      }
      if(event.source==='donationalerts' && event.type==='donation' && (!event.actor || ["аноним","anonymous","anon"].includes(matchKey(event.actor.displayName))))new DonationLedger(this.db).ensureAnonymous(event.accountId);
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
        if(event.source==='donationalerts'){
          const key=matchKey(event.actor.displayName),bound=this.db.prepare('SELECT coalesce(i.person_id,b.person_id) AS personId FROM donor_bindings b LEFT JOIN identities i ON i.id=b.identity_id WHERE b.name_key=?').get(key) as {personId:string}|undefined;
          if(identity&&bound&&identity.person_id!==bound.personId){this.db.prepare('UPDATE identities SET person_id=? WHERE id=?').run(bound.personId,identity.id);identity.person_id=bound.personId;}
        }
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
          const linked = this.links.resolveAutoLinkPerson(
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
        new RecentEvents(this.db).redact(event.accountId,event.type,messageId,userId,scope,atMs);
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
        this.links.rememberAlias(
          identity.id,
          event.actor.displayName,
          event.receivedAtMs,
        );
      if (event.occurredAtMs !== null)
        this.streams.assignEvent(eventKey(event), event.accountId, event.occurredAtMs);
      if (event.source === "twitch" && event.type === "channel.update" && event.occurredAtMs !== null) {
        const categoryId = event.payload.categoryId, categoryName = event.payload.categoryName, title = event.payload.title;
        if ([categoryId, categoryName, title].some(value => typeof value !== "string" || value.length > 1000)) throw new Error("INVALID_CHANNEL_UPDATE");
        this.db.prepare("INSERT INTO stream_samples(session_id,observed_at_ms,category_id,category_name,title,twitch_viewers,youtube_viewers) SELECT session_id,?,?,?,?,NULL,NULL FROM event_sessions WHERE event_id=? ON CONFLICT(session_id,observed_at_ms) DO UPDATE SET category_id=excluded.category_id,category_name=excluded.category_name,title=excluded.title").run(event.occurredAtMs,categoryId,categoryName,title,eventKey(event));
      }
      // Membership changes invalidate outstanding undo revisions, including arrival of a new identity.
      if(identity&&event.source==='donationalerts'&&event.actor)this.db.prepare('UPDATE donor_bindings SET identity_id=coalesce(identity_id,?) WHERE name_key=?').run(identity.id,matchKey(event.actor.displayName));
      // Auto-link already bumped revision when attaching to an existing person.
      if (identity && newIdentity && !autoLinked)
        this.db
          .prepare("UPDATE persons SET revision = revision + 1 WHERE id = ?")
          .run(identity.person_id);
      if(event.source==='donationalerts'&&event.type==='donation')new ProviderStorage(this.db).clearImported(event.accountId,event.externalId);
      new RecentEvents(this.db).saveEvent(event);
      return {
        inserted: true,
        identityId: identity?.id ?? null,
        personId: identity?.person_id ?? null,
      };
    }).immediate();
  }

  ingestLiveDonation(event: EventInput, expectedSessionId: string, allowUnknownTime = false): ReturnType<EventIngestion['ingest']>|null {
    if(event.source!=="donationalerts" || event.type!=="donation")throw new Error("INVALID_LIVE_DONATION");
    return this.db.transaction(()=>{
      const active=this.streams.activeLogicalStream() as {id:string;started_at_ms:number}|null;
      if(!active || active.id!==expectedSessionId || event.receivedAtMs<active.started_at_ms)return null;
      if(event.occurredAtMs===null ? !allowUnknownTime : event.occurredAtMs<active.started_at_ms)return null;
      const result=this.ingest(event);
      if(event.occurredAtMs===null && allowUnknownTime && event.transport==='centrifugo')
        this.db.prepare('INSERT OR IGNORE INTO event_sessions VALUES (?,?)').run(eventKey(event),active.id);
      return result;
    }).immediate();
  }

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

}


