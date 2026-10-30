import type Database from "better-sqlite3";
import {sharedDonorFilter} from "./shared-identity-schema.js";

export type KeyRow={id:string;person_id:string;link_key:string};

/** Account rows of one profile for the given shared keys, through the indexed columns. */
export function accountsFor(db:Database.Database,keys:Iterable<string>):KeyRow[] {
  const all=JSON.stringify([...keys]);
  return db.prepare(`WITH k(value) AS (SELECT value FROM json_each(?))
    SELECT id,person_id,'twitch:'||external_id AS link_key FROM identities WHERE source='twitch' AND external_id IN (SELECT substr(value,8) FROM k WHERE substr(value,1,7)='twitch:')
    UNION ALL SELECT id,person_id,'da:'||match_key FROM identities WHERE source='donationalerts' AND match_key IN (SELECT substr(value,4) FROM k WHERE substr(value,1,3)='da:') AND ${sharedDonorFilter}
    UNION ALL SELECT id,person_id,'youtube:'||external_id FROM youtube_identities WHERE external_id IN (SELECT substr(value,9) FROM k WHERE substr(value,1,8)='youtube:')
    ORDER BY person_id,link_key,id`).all(all) as KeyRow[];
}
/** Keys that one profile holds under more than one person stay local: they never move persons. */
export function unambiguous(rows:KeyRow[]):KeyRow[] {
  const persons=new Map<string,Set<string>>();
  for(const row of rows)persons.set(row.link_key,(persons.get(row.link_key)??new Set<string>()).add(row.person_id));
  return rows.filter(row=>persons.get(row.link_key)!.size===1);
}
/** Keys whose rows in this profile are held by several persons. */
export function ambiguousKeys(db:Database.Database,keys:Iterable<string>):Set<string> {
  const rows=accountsFor(db,keys),kept=new Set(unambiguous(rows).map(row=>row.link_key));
  return new Set(rows.map(row=>row.link_key).filter(key=>!kept.has(key)));
}
export function clusterOf(db:Database.Database,key:string):string|null {
  return (db.prepare("SELECT cluster FROM sp_identity_links WHERE link_key=?").get(key) as {cluster:string}|undefined)?.cluster??null;
}
export function membersOf(db:Database.Database,cluster:string):string[] {
  return (db.prepare("SELECT link_key FROM sp_identity_links WHERE cluster=? ORDER BY link_key").all(cluster) as {link_key:string}[]).map(row=>row.link_key);
}
/** The one person of this profile that already holds an account shared with `key`, if any. */
export function sharedHolder(db:Database.Database,key:string):string|null {
  const cluster=clusterOf(db,key);
  if(!cluster)return null;
  const persons=new Set(unambiguous(accountsFor(db,membersOf(db,cluster))).map(row=>row.person_id));
  return persons.size===1?[...persons][0]!:null;
}
/** Shared key of a new account, or null for profile-only accounts. */
export function linkKey(source:string,externalId:string,key:string):string|null {
  if(source==="twitch")return `twitch:${externalId}`;
  if(source==="youtube")return `youtube:${externalId}`;
  return key&&!["аноним","anonymous","anon"].includes(key)?`da:${key}`:null;
}

