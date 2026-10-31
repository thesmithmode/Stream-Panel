import type Database from "better-sqlite3";
import {randomUUID} from "node:crypto";
import {IdentityLinks} from "./identity-links.js";
import {profileView,rawConnection} from "./profile-db.js";
import {CURRENT_SCHEMA_VERSION} from "./schema.js";
import {SHARED_IDENTITY_VERSION} from "./shared-identity-schema.js";
import {accountsFor,ambiguousKeys,clusterOf,membersOf,sharedHolder,unambiguous,type KeyRow} from "./shared-identity-keys.js";

interface Profile {name:string;db:Database.Database;links:IdentityLinks}
/** The acting profile's person that keeps the existing shared group when one group becomes two. */
export interface SyncHint {keep?:string}
const solo=(key:string)=>`solo:${key}`;

/**
 * One account-to-person grouping shared by every profile of the physical file. Each profile
 * keeps its own persons, names, notes, tags, events and money; only which accounts belong
 * together is shared. Profiles record touched persons in identity_sync_queue (triggers),
 * publish them into sp_identity_links, and every other profile is conformed with its own
 * reversible merge/split operations. Replicated operations are not published back: the
 * queue is cleared in the same transaction after every published change was applied.
 */
export class SharedIdentities {
  private readonly raw:Database.Database;
  constructor(db:Database.Database,private readonly profile:string) {
    this.raw=(db as unknown as Record<symbol,Database.Database|undefined>)[rawConnection]??db;
  }

  private profiles():Profile[] {
    return (this.raw.prepare("SELECT profile FROM sp_profile_schema WHERE version BETWEEN ? AND ? ORDER BY profile").all(SHARED_IDENTITY_VERSION,CURRENT_SCHEMA_VERSION) as {profile:string}[]).map(({profile})=>{
      const db=profileView(this.raw,profile);
      return {name:profile,db,links:new IdentityLinks(db,id=>revision(db,id))};
    });
  }
  private joined():Set<string> {
    return new Set((this.raw.prepare("SELECT profile FROM sp_identity_sync_profiles").all() as {profile:string}[]).map(row=>row.profile));
  }
  private applied():Set<string> {
    return new Set((this.raw.prepare("SELECT profile FROM sp_identity_sync_applied").all() as {profile:string}[]).map(row=>row.profile));
  }

  /** Cheap check before taking the write lock. */
  pending():boolean {
    const joined=this.joined(),applied=this.applied();
    return this.profiles().some(p=>!joined.has(p.name)||!applied.has(p.name)||p.db.prepare("SELECT 1 FROM identity_sync_queue LIMIT 1").get()!==undefined);
  }

  /** Applies every queued membership change to all profiles. Returns the profiles whose persons changed. */
  sync(hint:SyncHint={}):string[] {
    return this.raw.transaction(()=>{
      const profiles=this.profiles(),joined=this.joined(),applied=this.applied(),now=Date.now();
      const changed=new Set<string>(),moved=new Set<string>(),names=new Map<string,string>(),touched=new Set<string>();
      for(const profile of profiles){
        if(joined.has(profile.name)){
          const queued=(profile.db.prepare("SELECT person_id FROM identity_sync_queue ORDER BY person_id").all() as {person_id:string}[]).map(row=>row.person_id);
          if(queued.length)this.publish(profile,queued,profile.name===this.profile?hint:{},now,changed,moved,names);
        }else{
          // A profile that starts sharing contributes all of its existing groups (union).
          this.join(profile,now,changed);
          this.raw.prepare("INSERT INTO sp_identity_sync_profiles VALUES (?,?)").run(profile.name,now);
        }
        // An unchanged journal does not mean this profile already follows it.
        // Reconcile once per profile, including files opened by the early v29
        // implementation; normal writes still process only changed keys.
        if(!applied.has(profile.name))for(const row of profile.db.prepare("SELECT DISTINCT link_key FROM identity_link_keys").all() as {link_key:string}[])changed.add(row.link_key);
      }
      if(changed.size)for(const profile of profiles){
        if(this.conform(profile,changed,moved,names,now))touched.add(profile.name);
      }
      for(const profile of profiles){
        profile.db.prepare("DELETE FROM identity_sync_queue").run();
        if(!applied.has(profile.name))this.raw.prepare("INSERT INTO sp_identity_sync_applied VALUES (?)").run(profile.name);
      }
      return [...touched];
    }).immediate();
  }

  /** Copies a DonationAlerts nickname binding to every other profile that holds the bound group. */
  shareDonorBinding(key:string,name:string,at:number):string[] {
    const touched:string[]=[];
    for(const profile of this.profiles()){
      if(profile.name===this.profile)continue;
      const person=sharedHolder(profile.db,`da:${key}`);
      if(!person)continue;
      const anchor=accountsFor(profile.db,[`da:${key}`]).find(row=>row.person_id===person)?.id??null;
      profile.db.prepare("INSERT INTO donor_bindings VALUES (?,?,?,?,?) ON CONFLICT(name_key) DO UPDATE SET name=excluded.name,person_id=excluded.person_id,identity_id=excluded.identity_id,updated_at_ms=excluded.updated_at_ms").run(key,name,person,anchor,at);
      touched.push(profile.name);
    }
    return touched;
  }

  private assign(keys:Set<string>,cluster:string|null,now:number,changed:Set<string>):void {
    for(const key of keys){
      const before=clusterOf(this.raw,key),after=keys.size>1?cluster:null;
      if(before===after)continue;
      if(after)this.raw.prepare("INSERT INTO sp_identity_links VALUES (?,?,?) ON CONFLICT(link_key) DO UPDATE SET cluster=excluded.cluster,updated_at_ms=excluded.updated_at_ms").run(key,after,now);
      else this.raw.prepare("DELETE FROM sp_identity_links WHERE link_key=?").run(key);
      changed.add(key);
    }
  }

  /** Union of a profile's current groups with the shared ones (transitive). */
  private join(profile:Profile,now:number,changed:Set<string>):void {
    const groups=new Map<string,string[]>();
    for(const row of unambiguous(profile.db.prepare("SELECT id,person_id,link_key FROM identity_link_keys ORDER BY person_id,link_key").all() as KeyRow[]))
      groups.set(row.person_id,[...groups.get(row.person_id)??[],row.link_key]);
    const parent=new Map<string,string>();
    const find=(node:string):string=>{
      let root=node;
      while(parent.has(root)&&parent.get(root)!==root)root=parent.get(root)!;
      parent.set(node,root);
      return root;
    };
    const node=(key:string)=>clusterOf(this.raw,key)??solo(key);
    for(const keys of groups.values()){
      const nodes=keys.map(node),first=find(nodes[0]!);
      for(const other of nodes.slice(1)){
        const a=find(first),b=find(other);
        if(a!==b)parent.set(a<b?b:a,a<b?a:b);
      }
    }
    const components=new Map<string,Set<string>>();
    for(const item of parent.keys()){
      const root=find(item),keys=components.get(root)??new Set<string>();
      if(item.startsWith("solo:"))keys.add(item.slice(5));
      else for(const key of membersOf(this.raw,item))keys.add(key);
      components.set(root,keys);
    }
    for(const [root,keys] of components)this.assign(keys,root.startsWith("solo:")?randomUUID():root,now,changed);
  }

  /** Queued persons are authoritative for their own accounts; other accounts keep their group. */
  private publish(profile:Profile,queued:string[],hint:SyncHint,now:number,changed:Set<string>,moved:Set<string>,names:Map<string,string>):void {
    const rows=profile.db.prepare("SELECT id,person_id,link_key FROM identity_link_keys WHERE person_id IN (SELECT value FROM json_each(?)) ORDER BY person_id,link_key").all(JSON.stringify(queued)) as KeyRow[];
    const ambiguous=ambiguousKeys(profile.db,rows.map(row=>row.link_key));
    const owned=new Map<string,Set<string>>(),holderOf=new Map<string,string>();
    for(const row of rows){
      if(ambiguous.has(row.link_key))continue;
      owned.set(row.person_id,(owned.get(row.person_id)??new Set<string>()).add(row.link_key));
      holderOf.set(row.link_key,row.person_id);
    }
    const previous=new Map<string,string[]>();
    for(const key of holderOf.keys()){
      const cluster=clusterOf(this.raw,key);
      if(cluster&&!previous.has(cluster))previous.set(cluster,membersOf(this.raw,cluster));
    }
    const keeper=new Map<string,string>();
    for(const [cluster,keys] of previous){
      const counts=new Map<string,number>();
      for(const key of keys){
        const person=holderOf.get(key);
        if(person)counts.set(person,(counts.get(person)??0)+1);
      }
      const ranked=[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
      keeper.set(cluster,hint.keep&&counts.has(hint.keep)?hint.keep:ranked[0]![0]);
    }
    for(const [person,accounts] of owned){
      const kept=[...keeper].filter(([,owner])=>owner===person).map(([cluster])=>cluster).sort();
      const keys=new Set(accounts);
      for(const cluster of kept)for(const key of previous.get(cluster)!)if(!holderOf.has(key)&&!ambiguous.has(key))keys.add(key);
      const cluster=kept[0]??randomUUID();
      this.assign(keys,cluster,now,changed);
      // Accounts that left a kept group are the ones that move in other profiles.
      for(const old of kept)for(const key of previous.get(old)!)if(!keys.has(key))moved.add(key);
      const name=(profile.db.prepare("SELECT display_name FROM persons WHERE id=?").get(person) as {display_name:string}).display_name;
      if(keys.size>1)names.set(cluster,name);
    }
  }

  /** Makes one profile hold exactly one person per shared group among the changed accounts. */
  private conform(profile:Profile,changed:Set<string>,moved:Set<string>,names:Map<string,string>,now:number):boolean {
    let touched=false;
    const target=(key:string)=>clusterOf(this.raw,key)??solo(key);
    const persons=[...new Set(unambiguous(accountsFor(profile.db,changed)).map(row=>row.person_id))];
    for(const person of persons){
      const rows=profile.db.prepare("SELECT id,person_id,link_key FROM identity_link_keys WHERE person_id=? ORDER BY id").all(person) as KeyRow[];
      const ambiguous=ambiguousKeys(profile.db,rows.map(row=>row.link_key));
      const groups=new Map<string,KeyRow[]>();
      for(const row of rows){
        if(ambiguous.has(row.link_key))continue;
        const group=target(row.link_key);
        groups.set(group,[...groups.get(group)??[],row]);
      }
      if(groups.size<2)continue;
      // The part whose accounts did not move stays; moved parts leave this person.
      const stay=(list:KeyRow[])=>list.filter(row=>!moved.has(row.link_key)).length;
      const ordered=[...groups].sort((a,b)=>stay(b[1])-stay(a[1])||b[1].length-a[1].length||a[0].localeCompare(b[0]));
      for(const [group,list] of ordered.slice(1))this.detach(profile,person,group,list,names,now);
      touched=true;
    }
    const clusters=[...new Set([...changed].map(key=>clusterOf(this.raw,key)).filter((cluster):cluster is string=>cluster!==null))].sort();
    for(const cluster of clusters){
      const holders=[...new Set(unambiguous(accountsFor(profile.db,membersOf(this.raw,cluster))).map(row=>row.person_id))].sort();
      if(holders.length<2)continue;
      touched=true;
      if(holders.length===2&&this.reunite(profile,holders,now))continue;
      const [main,...rest]=holders.map(id=>({id,...rank(profile.db,id)})).sort((a,b)=>b.manual-a.manual||b.accounts-a.accounts||b.twitch-a.twitch||a.id.localeCompare(b.id));
      for(const other of rest)profile.links.merge(other.id,main!.id,revision(profile.db,other.id),revision(profile.db,main!.id),now);
    }
    return touched;
  }

  /** Moves accounts out of a person: undo the merge that brought exactly them, otherwise split
   * them off and hand them to this profile's person that already holds their group. */
  private detach(profile:Profile,person:string,group:string,rows:KeyRow[],names:Map<string,string>,now:number):void {
    const ids=new Set(rows.map(row=>row.id));
    const others=group.startsWith("solo:")?[]:[...new Set(unambiguous(accountsFor(profile.db,membersOf(this.raw,group))).map(row=>row.person_id))].filter(id=>id!==person).sort();
    const merges=profile.db.prepare("SELECT id,source_person_id,before_json FROM person_merges WHERE target_person_id=? AND undone_at_ms IS NULL ORDER BY created_at_ms DESC,id DESC").all(person) as {id:string;source_person_id:string;before_json:string}[];
    for(const merge of merges){
      const moved=(JSON.parse(merge.before_json) as {id:string;personId:string}[]).filter(m=>m.personId===merge.source_person_id).map(m=>m.id);
      if(moved.length!==ids.size||!moved.every(id=>ids.has(id)))continue;
      try{profile.links.undoMerge(merge.id,now);return;}
      catch(error){if(!(error instanceof Error)||error.message!=="UNDO_CONFLICT")throw error;}
    }
    const first=profile.db.prepare("SELECT display_name FROM identities WHERE id=? UNION ALL SELECT display_name FROM youtube_identities WHERE id=?").get(rows[0]!.id,rows[0]!.id) as {display_name:string};
    const name=(names.get(group)??first.display_name).trim().slice(0,200)||rows[0]!.link_key.slice(0,200);
    const split=profile.links.splitIdentities([...ids],name,revision(profile.db,person),now,false);
    if(others.length===1)profile.links.merge(split,others[0]!,revision(profile.db,split),revision(profile.db,others[0]!),now);
  }

  /** Two persons that one split separated are rejoined by undoing that split when it still applies. */
  private reunite(profile:Profile,[a,b]:string[],now:number):boolean {
    const split=profile.db.prepare("SELECT operation_id FROM split_guards WHERE undone_at_ms IS NULL AND ((source_person_id=? AND target_person_id=?) OR (source_person_id=? AND target_person_id=?)) ORDER BY operation_id LIMIT 1").get(a,b,b,a) as {operation_id:string}|undefined;
    if(!split)return false;
    try{profile.links.undoSplit(split.operation_id,now);return true;}
    catch(error){if(error instanceof Error&&error.message==="UNDO_CONFLICT")return false;throw error;}
  }
}

function revision(db:Database.Database,id:string):number {
  const row=db.prepare("SELECT revision FROM persons WHERE id=?").get(id) as {revision:number}|undefined;
  if(!row)throw new Error("PERSON_NOT_FOUND");
  return row.revision;
}
/** A renamed group keeps its name; otherwise the person with most accounts (then a Twitch one) receives the others. */
function rank(db:Database.Database,id:string):{manual:number;accounts:number;twitch:number} {
  const named=Number(db.pragma('user_version',{simple:true}))>=30;
  return db.prepare(`SELECT (${named?'EXISTS(SELECT 1 FROM person_names WHERE person_id=?) OR':''} (SELECT display_name FROM persons WHERE id=?) NOT IN (SELECT display_name FROM identities WHERE person_id=? UNION SELECT display_name FROM youtube_identities WHERE person_id=?)
      AND NOT EXISTS(SELECT 1 FROM split_guards WHERE target_person_id=? AND undone_at_ms IS NULL)) AS manual,
    (SELECT count(*) FROM identity_link_keys WHERE person_id=?) AS accounts,
    EXISTS(SELECT 1 FROM identities WHERE person_id=? AND source='twitch') AS twitch`).get(...(named?[id]:[]),id,id,id,id,id,id) as {manual:number;accounts:number;twitch:number};
}
