import type Database from "better-sqlite3";
import {randomUUID} from "node:crypto";
import {assertTimestamp,candidateKey,matchKey,type Source} from "./domain.js";
import {linkKey,sharedHolder} from "./shared-identity-keys.js";
interface IdentityRow {id:string;person_id:string}
interface Membership {id:string;personId:string}
interface MergeRow {before_json:string;expected_json:string;source_person_id:string;target_person_id:string;undone_at_ms:number|null}

/** Identity membership, reversible merges/splits and historical donor repair. */
export class IdentityLinks {
  constructor(private readonly db:Database.Database,private readonly revision:(id:string)=>number) {}
  private personRevision(id:string):number {return this.revision(id);}

  private memberships(personIds: string[]): Membership[] {
    return this.db
      .prepare(
        `SELECT id, person_id AS personId FROM identities WHERE person_id IN (${personIds.map(() => "?").join(",")}) UNION ALL SELECT id,person_id AS personId FROM youtube_identities WHERE person_id IN (${personIds.map(() => "?").join(",")}) ORDER BY id`,
      )
      .all(...personIds,...personIds) as Membership[];
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
      this.db.prepare("UPDATE youtube_identities SET person_id=? WHERE person_id=?").run(targetId,sourceId);
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
        this.db.prepare("UPDATE youtube_identities SET person_id=? WHERE id=?").run(member.personId,member.id);
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
         WHERE source = 'donationalerts' AND match_key != '' AND external_id!='anonymous:donor'
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
   * An account already grouped in another profile joins this profile's holder of that group.
   */
  resolveAutoLinkPerson(
    source: Source | "youtube",
    accountId: string,
    externalId: string,
    displayName: string,
  ): { personId: string; how: string } | null {
    const linked=this.sharedLinkPerson(source,externalId,displayName);
    if(linked)return linked;
    const key = matchKey(displayName);
    if (!key) return null;
    if(["аноним","anonymous","anon"].includes(key)){
      if(source!=="donationalerts")return null;
      const anonymous=this.db.prepare('SELECT i.person_id FROM anonymous_donors a JOIN identities i ON i.id=a.identity_id WHERE a.account_id=?').get(accountId) as {person_id:string}|undefined;
      return anonymous?{personId:anonymous.person_id,how:"anonymous_label"}:null;
    }
    if(source==='donationalerts'){
      const bound=this.db.prepare('SELECT coalesce(i.person_id,b.person_id) AS personId FROM donor_bindings b LEFT JOIN identities i ON i.id=b.identity_id WHERE b.name_key=?').get(key) as {personId:string}|undefined;
      if(bound)return {personId:bound.personId,how:'donor_nickname'};
    }
    const other = source;
    const rows = this.db
      .prepare(
        `SELECT DISTINCT person_id FROM identities
         WHERE source != ? AND match_key = ? AND account_id NOT LIKE 'correction:%' AND account_id NOT LIKE 'manual:%'
         UNION SELECT person_id FROM youtube_identities WHERE ? != 'youtube' AND match_key = ?`,
      )
      .all(other, key,other,key) as { person_id: string }[];
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

  /** The person of this profile that holds an account linked (in any profile) with this new account. */
  sharedLinkPerson(source:Source|"youtube",externalId:string,displayName:string):{personId:string;how:string}|null {
    const shared=linkKey(source,externalId,matchKey(displayName));
    const holder=shared?sharedHolder(this.db,shared):null;
    return holder?{personId:holder,how:"shared_link"}:null;
  }

  reconcileNicknameLinks(onlyKey?:string):void {
    const donors=this.db.prepare("SELECT DISTINCT person_id,match_key FROM identities WHERE source='donationalerts' AND match_key!='' AND external_id!='anonymous:donor' AND account_id NOT LIKE 'manual:%' AND account_id NOT LIKE 'correction:%' AND (? IS NULL OR match_key=?)").all(onlyKey??null,onlyKey??null) as {person_id:string;match_key:string}[];
    for(const donor of donors){
      if(this.db.prepare("SELECT 1 FROM donor_bindings WHERE name_key=?").get(donor.match_key))continue;
      const protectedGroup=this.db.prepare("SELECT 1 FROM identities WHERE person_id=? AND (source!='donationalerts' OR account_id LIKE 'manual:%' OR account_id LIKE 'correction:%') UNION SELECT 1 FROM youtube_identities WHERE person_id=? UNION SELECT 1 FROM person_merges WHERE source_person_id=? OR target_person_id=? UNION SELECT 1 FROM membership_operations o,json_each(o.before_json) b WHERE o.kind!='auto_link' AND CASE WHEN b.type='object' THEN json_extract(b.value,'$.personId') END=? LIMIT 1").get(donor.person_id,donor.person_id,donor.person_id,donor.person_id,donor.person_id);
      if(protectedGroup)continue;
      const targets=this.db.prepare("SELECT DISTINCT person_id FROM identities WHERE source='twitch' AND match_key=? AND person_id!=? UNION SELECT person_id FROM youtube_identities WHERE match_key=? AND person_id!=?").all(donor.match_key,donor.person_id,donor.match_key,donor.person_id) as {person_id:string}[];
      if(targets.length!==1)continue;
      const target=targets[0]!.person_id;
      if(this.db.prepare("SELECT 1 FROM identities WHERE person_id=? AND source='donationalerts' AND match_key=?").get(target,donor.match_key))continue;
      this.merge(donor.person_id,target,this.personRevision(donor.person_id),this.personRevision(target),Date.now());
    }
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
          "SELECT DISTINCT i.person_id FROM identities i LEFT JOIN identity_aliases a ON a.identity_id = i.id WHERE i.candidate_key = ? OR a.candidate_key = ? UNION SELECT DISTINCT y.person_id FROM youtube_identities y LEFT JOIN youtube_identity_aliases a ON a.identity_id=y.id WHERE y.match_key=? OR a.match_key=? ORDER BY person_id",
        )
        .all(candidateKey(name), candidateKey(name), matchKey(name), matchKey(name)) as { person_id: string }[]
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

  rememberAlias(identityId: string, name: string, nowMs: number): void {
    this.db
      .prepare(
        `INSERT INTO identity_aliases VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(identity_id, name) DO UPDATE SET last_seen_ms = excluded.last_seen_ms`,
      )
      .run(identityId, name, candidateKey(name), nowMs, nowMs);
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
          `SELECT id, person_id AS personId FROM identities WHERE id IN (${ids.map(() => "?").join(",")}) UNION ALL SELECT id,person_id AS personId FROM youtube_identities WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`,
        )
        .all(...ids,...ids) as Membership[];
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
      for (const identity of all) {
        this.db
          .prepare("UPDATE identities SET person_id=? WHERE id=?")
          .run(target, identity.id);
        this.db.prepare("UPDATE youtube_identities SET person_id=? WHERE id=?").run(target,identity.id);
      }
      this.db
        .prepare("UPDATE persons SET revision=revision+1 WHERE id=?")
        .run(source);
      const operationId=randomUUID();
      this.db
        .prepare("INSERT INTO membership_operations VALUES (?, ?, ?, ?, ?)")
        .run(
          operationId,
          "split",
          JSON.stringify(all),
          JSON.stringify(all.map((row) => ({ ...row, personId: target }))),
          nowMs,
        );
      this.db.prepare("INSERT INTO split_guards VALUES (?,?,?,?,NULL)").run(operationId,source,target,JSON.stringify({members:this.memberships([source,target]),sourceRevision:this.personRevision(source),targetRevision:this.personRevision(target)}));
      return target;
    }).immediate();
  }

  splits(): Record<string,unknown>[] {
    return this.db.prepare("SELECT g.operation_id AS id,g.source_person_id,g.target_person_id,o.created_at_ms,g.undone_at_ms FROM split_guards g JOIN membership_operations o ON o.id=g.operation_id ORDER BY o.created_at_ms DESC,g.operation_id LIMIT 100").all() as Record<string,unknown>[];
  }

  undoSplit(id: string, atMs: number): void {
    assertTimestamp(atMs);
    this.db.transaction(()=>{
      const operation=this.db.prepare("SELECT g.*,o.before_json FROM split_guards g JOIN membership_operations o ON o.id=g.operation_id WHERE g.operation_id=? AND o.kind='split'").get(id) as {source_person_id:string;target_person_id:string;expected_json:string;before_json:string;undone_at_ms:number|null}|undefined;
      if(!operation)throw new Error("SPLIT_NOT_FOUND");
      if(operation.undone_at_ms!==null)throw new Error("ALREADY_UNDONE");
      const expected=JSON.parse(operation.expected_json) as {members:Membership[];sourceRevision:number;targetRevision:number};
      if(this.personRevision(operation.source_person_id)!==expected.sourceRevision || this.personRevision(operation.target_person_id)!==expected.targetRevision || JSON.stringify(this.memberships([operation.source_person_id,operation.target_person_id]))!==JSON.stringify(expected.members))throw new Error("UNDO_CONFLICT");
      for(const member of JSON.parse(operation.before_json) as Membership[]){
        this.db.prepare("UPDATE identities SET person_id=? WHERE id=?").run(member.personId,member.id);
        this.db.prepare("UPDATE youtube_identities SET person_id=? WHERE id=?").run(member.personId,member.id);
      }
      this.db.prepare("UPDATE persons SET revision=revision+1 WHERE id IN(?,?)").run(operation.source_person_id,operation.target_person_id);
      this.db.prepare("UPDATE split_guards SET undone_at_ms=? WHERE operation_id=?").run(atMs,id);
    }).immediate();
  }

  merges(): Record<string, unknown>[] {
    return this.db
      .prepare(
        "SELECT id, source_person_id, target_person_id, created_at_ms, undone_at_ms FROM person_merges ORDER BY created_at_ms DESC LIMIT 100",
      )
      .all() as Record<string, unknown>[];
  }


}
