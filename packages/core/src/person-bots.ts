import type Database from 'better-sqlite3';
import {botExclusionSet} from './bots.js';

const affectedStreams=(person:string)=>`SELECT es.session_id FROM event_sessions es JOIN events e ON e.id=es.event_id JOIN identities i ON i.id=e.identity_id WHERE i.person_id=${person}
 UNION SELECT p.session_id FROM presence_polls p JOIN presence_members m ON m.poll_id=p.id JOIN identities i ON i.id=m.identity_id WHERE i.person_id=${person}
 UNION SELECT p.session_id FROM platform_streams p JOIN youtube_messages m ON m.account_id=p.account_id AND m.published_at_ms>=p.started_at_ms AND m.published_at_ms<coalesce(p.ended_at_ms,9223372036854775807) JOIN youtube_identities i ON i.account_id=m.account_id AND i.external_id=m.author_id WHERE p.platform='youtube' AND i.person_id=${person}`;
const refresh=(person:string)=>{
 const effective=`EXISTS(SELECT 1 FROM manual_bot_people b WHERE b.person_id=${person})`;
 const human=`EXISTS(SELECT 1 FROM human_people h WHERE h.person_id=${person})`;
 const changed=`(coalesce((SELECT is_bot FROM person_bot_status WHERE person_id=${person}),0)<>${effective} OR coalesce((SELECT is_human FROM person_bot_status WHERE person_id=${person}),0)<>${human})`;
 return `UPDATE analytics_fact_versions SET activity=activity+1 WHERE (${changed}) AND session_id IN(${affectedStreams(person)});
 UPDATE ui_revisions SET revision=revision+1 WHERE (${changed}) AND domain IN('people','analyticsActivity','analyticsPresentation','overviewAttendance');
 INSERT INTO person_bot_status SELECT ${person},${effective},${human} WHERE ${person} IS NOT NULL ON CONFLICT(person_id) DO UPDATE SET is_bot=excluded.is_bot,is_human=excluded.is_human;`;
};
const classificationTriggers=[
 ['person_neutral_marks',(r:string)=>`(SELECT person_id FROM identities WHERE id=${r}.identity_id)`],
 ['person_human_marks',(r:string)=>`(SELECT person_id FROM identities WHERE id=${r}.identity_id)`],
 ['person_human_cards',(r:string)=>`${r}.person_id`],
 ['person_bot_marks',(r:string)=>`(SELECT person_id FROM identities WHERE id=${r}.identity_id)`],
 ['identities',(r:string)=>`${r}.person_id`],
 ['youtube_identities',(r:string)=>`${r}.person_id`],
 ['donor_bindings',(r:string)=>`${r}.person_id`],
 ['events',(r:string)=>`(SELECT person_id FROM identities WHERE id=${r}.identity_id)`],
 ['donation_corrections',(r:string)=>`(SELECT person_id FROM identities WHERE id=${r}.identity_id)`],
] as const;
const formerBotHumans=`SELECT i.person_id FROM identities i JOIN human_people h ON h.person_id=i.person_id WHERE i.match_key IN(SELECT value FROM json_each('${JSON.stringify([...botExclusionSet()])}')) UNION SELECT i.person_id FROM youtube_identities i JOIN human_people h ON h.person_id=i.person_id WHERE i.match_key IN(SELECT value FROM json_each('${JSON.stringify([...botExclusionSet()])}'))`;

// Identity anchors preserve the operator's decision across merge/split/undo.
// Eligibility is always evaluated against current links and effective donations.
export const personBotSchema=`
CREATE TABLE IF NOT EXISTS person_neutral_marks(identity_id TEXT PRIMARY KEY REFERENCES identities(id)) WITHOUT ROWID;
CREATE VIEW IF NOT EXISTS manual_neutral_people AS SELECT DISTINCT i.person_id FROM person_neutral_marks m JOIN identities i ON i.id=m.identity_id;
CREATE TABLE IF NOT EXISTS person_bot_marks(identity_id TEXT PRIMARY KEY REFERENCES identities(id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS person_human_marks(identity_id TEXT PRIMARY KEY REFERENCES identities(id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS person_human_cards(person_id TEXT PRIMARY KEY REFERENCES persons(id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS person_bot_status(person_id TEXT PRIMARY KEY,is_bot INTEGER NOT NULL,is_human INTEGER NOT NULL) WITHOUT ROWID;
CREATE VIEW IF NOT EXISTS donor_people AS SELECT DISTINCT i.person_id FROM effective_events e JOIN identities i ON i.id=e.identity_id WHERE e.type='donation';
CREATE VIEW IF NOT EXISTS automatic_human_people AS SELECT person_id FROM youtube_identities UNION SELECT person_id FROM identities WHERE source='donationalerts' UNION SELECT person_id FROM donor_people UNION SELECT person_id FROM donor_bindings;
CREATE VIEW IF NOT EXISTS manual_human_people AS WITH RECURSIVE cards(person_id) AS(SELECT person_id FROM person_human_cards UNION SELECT m.target_person_id FROM person_merges m JOIN cards c ON m.source_person_id=c.person_id WHERE m.undone_at_ms IS NULL) SELECT person_id FROM cards UNION SELECT i.person_id FROM person_human_marks m JOIN identities i ON i.id=m.identity_id;
CREATE VIEW IF NOT EXISTS human_people AS SELECT person_id FROM automatic_human_people UNION SELECT person_id FROM manual_human_people;
CREATE VIEW IF NOT EXISTS bot_eligible_people AS SELECT p.id person_id FROM persons p
 WHERE EXISTS(SELECT 1 FROM identities i WHERE i.person_id=p.id AND i.source='twitch')
 AND NOT EXISTS(SELECT 1 FROM identities i WHERE i.person_id=p.id AND (i.source<>'twitch' OR i.external_id=i.account_id))
 AND NOT EXISTS(SELECT 1 FROM youtube_identities y WHERE y.person_id=p.id)
 AND NOT EXISTS(SELECT 1 FROM donor_bindings d WHERE d.person_id=p.id)
 AND NOT EXISTS(SELECT 1 FROM donor_people d WHERE d.person_id=p.id);
CREATE VIEW IF NOT EXISTS manual_bot_people AS SELECT DISTINCT i.person_id FROM person_bot_marks m JOIN identities i ON i.id=m.identity_id JOIN bot_eligible_people e ON e.person_id=i.person_id WHERE i.person_id NOT IN(SELECT person_id FROM human_people);
CREATE TRIGGER IF NOT EXISTS bot_mark_insert AFTER INSERT ON person_bot_marks BEGIN UPDATE persons SET revision=revision+1 WHERE id=(SELECT person_id FROM identities WHERE id=NEW.identity_id); END;
CREATE TRIGGER IF NOT EXISTS bot_mark_delete AFTER DELETE ON person_bot_marks BEGIN UPDATE persons SET revision=revision+1 WHERE id=(SELECT person_id FROM identities WHERE id=OLD.identity_id); END;
${classificationTriggers.flatMap(([table,person])=>['INSERT','UPDATE','DELETE'].map(op=>{
 const rows=op==='INSERT'?['NEW']:op==='DELETE'?['OLD']:['OLD','NEW'];
 const relevant=rows.map(r=>person(r));
 const guard=['person_bot_marks','person_human_marks','person_human_cards','person_neutral_marks'].includes(table)?'':`WHEN EXISTS(SELECT 1 FROM person_bot_status WHERE person_id IN(${relevant.join(',')})) OR EXISTS(SELECT 1 FROM identities i WHERE i.person_id IN(${relevant.join(',')}) AND (i.id IN(SELECT identity_id FROM person_bot_marks) OR i.id IN(SELECT identity_id FROM person_human_marks)))`;
 return `CREATE TRIGGER IF NOT EXISTS bot_status_${table}_${op.toLowerCase()} AFTER ${op} ON ${table} ${guard} BEGIN ${relevant.map(refresh).join('\n')} END;`;
})).join('\n')}
-- Preserve ordinary history caches. Only old bot-name exclusions that now
-- qualify as human need their physical stream facts recalculated on upgrade.
UPDATE analytics_fact_versions SET activity=activity+1 WHERE session_id IN(
 SELECT es.session_id FROM event_sessions es JOIN events e ON e.id=es.event_id JOIN identities i ON i.id=e.identity_id WHERE i.person_id IN(${formerBotHumans})
 UNION SELECT p.session_id FROM presence_polls p JOIN presence_members m ON m.poll_id=p.id JOIN identities i ON i.id=m.identity_id WHERE i.person_id IN(${formerBotHumans})
 UNION SELECT p.session_id FROM platform_streams p JOIN youtube_messages m ON m.account_id=p.account_id AND m.published_at_ms>=p.started_at_ms AND m.published_at_ms<coalesce(p.ended_at_ms,9223372036854775807) JOIN youtube_identities i ON i.account_id=m.account_id AND i.external_id=m.author_id WHERE p.platform='youtube' AND i.person_id IN(${formerBotHumans})
);
PRAGMA user_version=32;
`;

/** Names use the existing list; manual decisions use person IDs, never names. */
export function databaseBotExclusions(db:Database.Database,extra:readonly string[]|false=[]):ReadonlySet<string>{
 const keys=new Set(botExclusionSet(extra));
 if(extra!==false)for(const row of db.prepare('SELECT person_id FROM manual_bot_people').all() as {person_id:string}[])keys.add('person:'+row.person_id);
 return keys;
}

export class PersonBots {
 constructor(private db:Database.Database){}
 setClassification(id:string,kind:'bot'|'unknown'|'human',revision:number){
  if(!['bot','unknown','human'].includes(kind)||!Number.isSafeInteger(revision)||revision<0)throw Error('INVALID_PERSON_CLASSIFICATION');
  return this.db.transaction(()=>{
   const current=this.state(id);
   if(current.revision!==revision)throw Error('REVISION_CONFLICT');
   if(current.automaticHuman){
    if(kind!=='human')throw Error('INVALID_AUTOMATIC_CLASSIFICATION');
    return current;
   }
   if(kind==='bot')return this.set(id,true,revision);
   if(kind==='human')return this.setHuman(id,true,revision);
   const cleared=this.set(id,false,revision);
   this.setHuman(id,false,cleared.revision);
   this.db.prepare("INSERT OR IGNORE INTO person_neutral_marks SELECT id FROM identities WHERE person_id=? AND source='twitch' ORDER BY id LIMIT 1").run(id);
   this.db.prepare(`UPDATE analytics_fact_versions SET activity=activity+1 WHERE session_id IN(${affectedStreams('@person')})`).run({person:id});
   this.db.prepare("UPDATE ui_revisions SET revision=revision+1 WHERE domain IN('analyticsPresentation','overviewAttendance')").run();
   return this.state(id);
  }).immediate();
 }
 state(id:string,extra:readonly string[]=[]){
  const p=this.db.prepare(`SELECT p.revision,EXISTS(SELECT 1 FROM bot_eligible_people e WHERE e.person_id=p.id) canMarkBot,
   EXISTS(SELECT 1 FROM manual_bot_people b WHERE b.person_id=p.id) manualBot,
   EXISTS(SELECT 1 FROM donor_people d WHERE d.person_id=p.id) isDonor,
   EXISTS(SELECT 1 FROM automatic_human_people h WHERE h.person_id=p.id) automaticHuman,
   EXISTS(SELECT 1 FROM manual_human_people h WHERE h.person_id=p.id) manualHuman,
   (EXISTS(SELECT 1 FROM identities i WHERE i.person_id=p.id AND i.source='twitch' AND i.match_key IN(SELECT value FROM json_each(?))) AND NOT EXISTS(SELECT 1 FROM manual_neutral_people n WHERE n.person_id=p.id)) knownBot FROM persons p WHERE p.id=?`).get(JSON.stringify([...botExclusionSet(extra)]),id) as {revision:number;canMarkBot:number;manualBot:number;isDonor:number;automaticHuman:number;manualHuman:number;knownBot:number}|undefined;
  if(!p)throw Error('PERSON_NOT_FOUND');
  return {...p,canMarkBot:!!p.canMarkBot,manualBot:!!p.manualBot,isDonor:!!p.isDonor,automaticHuman:!!p.automaticHuman,manualHuman:!!p.manualHuman,knownBot:!!p.knownBot&&!p.automaticHuman&&!p.manualHuman};
 }
 set(id:string,bot:boolean,revision:number){
  if(typeof bot!=='boolean'||!Number.isSafeInteger(revision)||revision<0)throw Error('INVALID_BOT_MARK');
  return this.db.transaction(()=>{
   const current=this.state(id);
   if(current.revision!==revision)throw Error('REVISION_CONFLICT');
   if(bot&&!current.canMarkBot)throw Error('BOT_NOT_ELIGIBLE');
   if(bot)this.db.prepare('DELETE FROM person_human_marks WHERE identity_id IN(SELECT id FROM identities WHERE person_id=?)').run(id);
   if(bot)this.clearHumanCards(id);
   if(bot)this.db.prepare('DELETE FROM person_neutral_marks WHERE identity_id IN(SELECT id FROM identities WHERE person_id=?)').run(id);
   if(bot)this.db.prepare("INSERT OR IGNORE INTO person_bot_marks SELECT id FROM identities WHERE person_id=? AND source='twitch' ORDER BY id LIMIT 1").run(id);
   else this.db.prepare('DELETE FROM person_bot_marks WHERE identity_id IN(SELECT id FROM identities WHERE person_id=?)').run(id);
   return this.state(id);
  }).immediate();
 }
 setHuman(id:string,human:boolean,revision:number){
  if(typeof human!=='boolean'||!Number.isSafeInteger(revision)||revision<0)throw Error('INVALID_HUMAN_MARK');
  return this.db.transaction(()=>{
   const current=this.state(id);if(current.revision!==revision)throw Error('REVISION_CONFLICT');
   if(human){
    this.db.prepare('DELETE FROM person_neutral_marks WHERE identity_id IN(SELECT id FROM identities WHERE person_id=?)').run(id);
    this.db.prepare('DELETE FROM person_bot_marks WHERE identity_id IN(SELECT id FROM identities WHERE person_id=?)').run(id);
    this.db.prepare("INSERT OR IGNORE INTO person_human_marks SELECT id FROM identities WHERE person_id=? AND source='twitch' ORDER BY id LIMIT 1").run(id);
    this.db.prepare('INSERT OR IGNORE INTO person_human_cards SELECT ? WHERE NOT EXISTS(SELECT 1 FROM identities WHERE person_id=?) AND NOT EXISTS(SELECT 1 FROM youtube_identities WHERE person_id=?)').run(id,id,id);
   }else{this.db.prepare('DELETE FROM person_human_marks WHERE identity_id IN(SELECT id FROM identities WHERE person_id=?)').run(id);this.clearHumanCards(id);}
   this.db.prepare('UPDATE persons SET revision=revision+1 WHERE id=?').run(id);
   return this.state(id);
  }).immediate();
 }
 private clearHumanCards(id:string){this.db.prepare(`WITH RECURSIVE owners(id) AS(SELECT ? UNION SELECT m.source_person_id FROM person_merges m JOIN owners o ON o.id=m.target_person_id WHERE m.undone_at_ms IS NULL) DELETE FROM person_human_cards WHERE person_id IN(SELECT id FROM owners)`).run(id);}
 decorate<T>(rows:T[],id:(row:T)=>string|null|undefined,extra:readonly string[]=[]):(T&{is_bot:number;is_donor:boolean;is_human:boolean})[]{
  const ids=JSON.stringify([...new Set(rows.map(id).filter(Boolean))]),keys=JSON.stringify([...botExclusionSet(extra)]);
  const states=this.db.prepare(`SELECT p.id,EXISTS(SELECT 1 FROM manual_neutral_people n WHERE n.person_id=p.id) neutral,EXISTS(SELECT 1 FROM human_people h WHERE h.person_id=p.id) human,EXISTS(SELECT 1 FROM donor_people d WHERE d.person_id=p.id) donor,
   (EXISTS(SELECT 1 FROM manual_bot_people b WHERE b.person_id=p.id) OR EXISTS(SELECT 1 FROM identities i WHERE i.person_id=p.id AND i.source='twitch' AND i.match_key IN(SELECT value FROM json_each(?)))) bot
   FROM persons p WHERE p.id IN(SELECT value FROM json_each(?))`).all(keys,ids) as {id:string;donor:number;bot:number;human:number;neutral:number}[];
  const map=new Map(states.map(s=>[s.id,s]));
  return rows.map(row=>{const s=map.get(id(row)??'');return {...row,is_bot:Number(!!s?.bot&&!s?.human&&!s?.neutral),is_donor:!!s?.donor,is_human:!!s?.human};});
 }
}
