import type Database from 'better-sqlite3';
import {PersonBots} from './person-bots.js';
import {accountsFor,unambiguous,clusterOf,membersOf} from './shared-identity-keys.js';
type Kind='bot'|'unknown'|'human';
type Profile={name:string;db:Database.Database};
/** Manual decisions follow stable provider accounts, never display names. */
export class SharedClassifications {
 constructor(private raw:Database.Database){}
 pending(profiles:Profile[]){return this.raw.prepare('SELECT 1 FROM sp_profile_schema p WHERE p.version>=32 AND p.profile IN(SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM sp_classification_profiles c WHERE c.profile=p.profile) LIMIT 1').get(JSON.stringify(profiles.map(p=>p.name)))!==undefined;}
 seed(profiles:Profile[]):string[]{
  const fresh=profiles.filter(p=>Number(p.db.pragma('user_version',{simple:true}))>=32&&!this.raw.prepare('SELECT 1 FROM sp_classification_profiles WHERE profile=?').get(p.name));
  if(!fresh.length)return [];
  const save=this.raw.prepare('INSERT OR IGNORE INTO sp_person_classifications VALUES(?,?,0)');
  // Old marks have no timestamp: preserve an explicit human before a conflicting bot.
  for(const kind of ['human','bot','unknown'] as Kind[])for(const p of fresh){
   const sql=kind==='human'?"SELECT person_id FROM manual_human_people":kind==='bot'?"SELECT person_id FROM manual_bot_people":"SELECT DISTINCT i.person_id FROM person_neutral_marks m JOIN identities i ON i.id=m.identity_id";
   const keys=(p.db.prepare(`SELECT DISTINCT k.link_key FROM identity_link_keys k WHERE k.person_id IN(${sql})`).all() as {link_key:string}[]).map(r=>r.link_key);
   for(const row of unambiguous(accountsFor(p.db,keys)))save.run(row.link_key,kind);
  }
  for(const p of fresh)this.raw.prepare('INSERT INTO sp_classification_profiles VALUES(?)').run(p.name);
  return (this.raw.prepare('SELECT link_key FROM sp_person_classifications').all() as {link_key:string}[]).map(r=>r.link_key);
 }
 publish(profiles:Profile[],source:string,person:string,kind:Kind):string[]{
  const profile=profiles.find(p=>p.name===source);if(!profile)return [];
  const direct=(profile.db.prepare('SELECT link_key FROM identity_link_keys WHERE person_id=?').all(person) as {link_key:string}[]).map(r=>r.link_key);
  const stable=unambiguous(accountsFor(profile.db,direct)).filter(r=>r.person_id===person).map(r=>r.link_key);
  const keys=[...new Set(stable.flatMap(key=>{const cluster=clusterOf(this.raw,key);return cluster?membersOf(this.raw,cluster):[key];}))];
  if(!keys.length)return [];
  if(kind==='bot')for(const target of profiles){if(Number(target.db.pragma('user_version',{simple:true}))<32)continue;const bots=new PersonBots(target.db);for(const id of new Set(unambiguous(accountsFor(target.db,keys)).map(r=>r.person_id)))if(!bots.state(id).canMarkBot)throw Error('BOT_NOT_ELIGIBLE');}
  const revision=(this.raw.prepare('SELECT coalesce(max(revision),0)+1 AS n FROM sp_person_classifications').get() as {n:number}).n;
  const save=this.raw.prepare('INSERT INTO sp_person_classifications VALUES(?,?,?) ON CONFLICT(link_key) DO UPDATE SET kind=excluded.kind,revision=excluded.revision');
  for(const key of keys)save.run(key,kind,revision);
  return this.apply(profiles.filter(p=>p.name!==source),keys);
 }
 apply(profiles:Profile[],keys:Iterable<string>):string[]{
  const all=[...new Set(keys)];if(!all.length)return [];
  const touched=new Set<string>();
  for(const p of profiles){
   if(Number(p.db.pragma('user_version',{simple:true}))<32)continue;
   const bots=new PersonBots(p.db);
   for(const id of new Set(unambiguous(accountsFor(p.db,all)).map(r=>r.person_id))){
    const localKeys=(p.db.prepare('SELECT link_key FROM identity_link_keys WHERE person_id=?').all(id) as {link_key:string}[]).map(r=>r.link_key);
    const decision=this.raw.prepare('SELECT kind FROM sp_person_classifications WHERE link_key IN(SELECT value FROM json_each(?)) ORDER BY revision DESC,link_key LIMIT 1').get(JSON.stringify(localKeys)) as {kind:Kind}|undefined;
    if(!decision)continue;
    const state=bots.state(id);
    if(state.automaticHuman||decision.kind==='bot'&&!state.canMarkBot)continue;
    const neutral=decision.kind==='unknown'&&p.db.prepare('SELECT 1 FROM person_neutral_marks m JOIN identities i ON i.id=m.identity_id WHERE i.person_id=? LIMIT 1').get(id)!==undefined;
    if(decision.kind==='human'&&state.manualHuman||decision.kind==='bot'&&state.manualBot||decision.kind==='unknown'&&!state.manualHuman&&!state.manualBot&&neutral)continue;
    bots.setClassification(id,decision.kind,state.revision);touched.add(p.name);
   }
  }
  return [...touched];
 }
}
