import type Database from "better-sqlite3";
import {randomUUID} from "node:crypto";
import {assertTimestamp} from "./domain.js";

/** Tags and notes retain merge provenance and use optimistic revision checks. */
export class PersonAnnotations {
  constructor(private readonly db:Database.Database) {}

  personMetadata(personId: string): {revision:number;tags:string[];manualCore:boolean|null} {
    const revision = this.personRevision(personId);
    const tags = this.db.prepare(`WITH RECURSIVE owners(id) AS (SELECT ? UNION SELECT m.source_person_id FROM person_merges m JOIN owners o ON m.target_person_id=o.id WHERE m.undone_at_ms IS NULL) SELECT DISTINCT t.label FROM person_tags t JOIN owners o ON t.person_id=o.id ORDER BY t.label`).all(personId) as {label:string}[];
    const preference = this.db.prepare("SELECT manual_core FROM person_preferences WHERE person_id=?").get(personId) as {manual_core:number|null} | undefined;
    return {revision,tags:tags.map(row=>row.label),manualCore:preference?.manual_core==null?null:preference.manual_core===1};
  }

  setPersonMetadata(personId: string, tags: string[], manualCore: boolean|null, revision: number): ReturnType<PersonAnnotations['personMetadata']> {
    if (!Array.isArray(tags) || tags.length>50 || tags.some(tag=>typeof tag!=="string" || !tag.trim() || tag.trim().length>64)) throw new Error("INVALID_PERSON_TAGS");
    if (manualCore!==null && typeof manualCore!=="boolean") throw new Error("INVALID_MANUAL_CORE");
    if (!Number.isSafeInteger(revision) || revision<0) throw new Error("INVALID_PERSON_REVISION");
    const wanted=[...new Set(tags.map(tag=>tag.trim()))];
    return this.db.transaction(() => {
      const current=this.personMetadata(personId);
      if (current.revision!==revision) throw new Error("REVISION_CONFLICT");
      // Retain provenance of inherited tags; only explicit removals delete them.
      this.db.prepare(`WITH RECURSIVE owners(id) AS (SELECT ? UNION SELECT m.source_person_id FROM person_merges m JOIN owners o ON m.target_person_id=o.id WHERE m.undone_at_ms IS NULL) DELETE FROM person_tags WHERE person_id IN(SELECT id FROM owners) AND label NOT IN(SELECT value FROM json_each(?))`).run(personId,JSON.stringify(wanted));
      const insert=this.db.prepare("INSERT OR IGNORE INTO person_tags VALUES (?,?)");
      for(const tag of wanted)if(!current.tags.includes(tag))insert.run(personId,tag);
      this.db.prepare("INSERT INTO person_preferences VALUES (?,?) ON CONFLICT(person_id) DO UPDATE SET manual_core=excluded.manual_core").run(personId,manualCore===null?null:Number(manualCore));
      this.db.prepare("UPDATE persons SET revision=revision+1 WHERE id=?").run(personId);
      return this.personMetadata(personId);
    }).immediate();
  }

  personNotes(personId: string): unknown[] {
    this.personRevision(personId);
    return this.db.prepare(`WITH RECURSIVE owners(id) AS (SELECT ? UNION SELECT m.source_person_id FROM person_merges m JOIN owners o ON m.target_person_id=o.id WHERE m.undone_at_ms IS NULL) SELECT n.* FROM person_notes n JOIN owners o ON n.person_id=o.id ORDER BY n.created_at_ms DESC,n.id`).all(personId);
  }

  createPersonNote(personId: string, body: string, nowMs = Date.now()): unknown {
    assertTimestamp(nowMs);
    const text = this.noteText(body);
    return this.db.transaction(() => {
      this.personRevision(personId);
      const id = randomUUID();
      this.db.prepare("INSERT INTO person_notes VALUES (?,?,?,?,?,0)").run(id,personId,text,nowMs,nowMs);
      return this.db.prepare("SELECT * FROM person_notes WHERE id=?").get(id);
    }).immediate();
  }

  updatePersonNote(personId: string, id: string, body: string, revision: number, nowMs = Date.now()): unknown {
    assertTimestamp(nowMs);
    const text = this.noteText(body);
    return this.db.transaction(() => {
      const note = this.requirePersonNote(personId,id,revision);
      this.db.prepare("UPDATE person_notes SET body=?,updated_at_ms=?,revision=revision+1 WHERE id=?").run(text,Math.max(nowMs,note.updated_at_ms),id);
      return this.db.prepare("SELECT * FROM person_notes WHERE id=?").get(id);
    }).immediate();
  }

  deletePersonNote(personId: string, id: string, revision: number): void {
    this.db.transaction(() => {
      this.requirePersonNote(personId,id,revision);
      this.db.prepare("DELETE FROM person_notes WHERE id=?").run(id);
    }).immediate();
  }

  private noteText(body: string): string {
    if (typeof body !== "string" || !body.trim() || body.length > 10000) throw new Error("INVALID_NOTE_BODY");
    return body.trim();
  }

  private requirePersonNote(personId: string, id: string, revision: number): {updated_at_ms:number} {
    this.personRevision(personId);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("INVALID_NOTE_REVISION");
    const note = this.db.prepare(`WITH RECURSIVE owners(id) AS (SELECT ? UNION SELECT m.source_person_id FROM person_merges m JOIN owners o ON m.target_person_id=o.id WHERE m.undone_at_ms IS NULL) SELECT n.revision,n.updated_at_ms FROM person_notes n JOIN owners o ON n.person_id=o.id WHERE n.id=?`).get(personId,id) as {revision:number;updated_at_ms:number} | undefined;
    if (!note) throw new Error("NOTE_NOT_FOUND");
    if (note.revision !== revision) throw new Error("NOTE_CONFLICT");
    return note;
  }

  personRevision(id: string): number {
    const person = this.db
      .prepare("SELECT id, revision FROM persons WHERE id = ?")
      .get(id) as {id:string;revision:number} | undefined;
    if (!person) throw new Error("PERSON_NOT_FOUND");
    return person.revision;
  }

}
