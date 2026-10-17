import Database from 'better-sqlite3';
import {randomUUID as uuid} from 'node:crypto';
import {mkdtempSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {schemaMigrations} from '../dist/packages/core/src/schema.js';
import {StreamStore} from '../dist/packages/core/src/store.js';
import {StoreClient} from '../dist/apps/daemon/src/db.js';
// Offline synthetic storage fixture; ingestion correctness is covered by integration tests.
// Run after build: node scripts/benchmark-growth.mjs 1000
const count=Number(process.argv[2]??1000);if(!Number.isInteger(count)||count<1||count>10000)throw Error('Expected 1–10000 streams');
const dir=mkdtempSync(join(tmpdir(),'sp-growth-')),path=join(dir,'facts.sqlite'),base=Date.UTC(2022,0,1),minute=60000;
const old=new Database(path);old.function('fixture_uuid',()=>uuid());
for(const sql of schemaMigrations.slice(0,19))old.exec(sql);
old.exec('DROP TRIGGER analytics_presence_members_insert');
// Only the disposable fixture uses relaxed durability while loading, never the application.
old.pragma('journal_mode=OFF');old.pragma('synchronous=OFF');old.pragma('cache_size=-16384');
const people=old.prepare('INSERT INTO persons VALUES(?,?,0)'),identity=old.prepare("INSERT INTO identities VALUES(?,'twitch','owner',?,?,?,?,?)"),alias=old.prepare('INSERT INTO identity_aliases VALUES(?,?,?,?,?)');
const nums=n=>`WITH RECURSIVE nums(n) AS(VALUES(0) UNION ALL SELECT n+1 FROM nums WHERE n<${n-1})`;
const polls=old.prepare(`${nums(240)} INSERT INTO presence_polls SELECT fixture_uuid(),?,'owner',?+max(0,n-1)*60000,?+n*60000,'complete' FROM nums`);
const members=old.prepare("INSERT INTO presence_members SELECT p.id,i.id FROM presence_polls p CROSS JOIN identities i WHERE p.session_id=? AND i.source='twitch' AND i.account_id='owner' AND i.external_id BETWEEN ? AND ?");
const samples=old.prepare(`${nums(240)} INSERT INTO stream_samples SELECT ?,?+n*60000,'game','Game','Fixture',40,NULL FROM nums`);
const events=old.prepare(`${nums(500)} INSERT INTO events SELECT fixture_uuid(),'twitch','owner',fixture_uuid(),'chat.message',(SELECT id FROM identities WHERE source='twitch' AND account_id='owner' AND external_id=cast(cast(? AS INTEGER)+n%40 AS TEXT)),?+cast(n*14400000/500 AS INTEGER),?+cast(n*14400000/500 AS INTEGER),NULL,'provider','eventsub','{"count":1,"originChannelId":null,"redacted":0}' FROM nums`);
let start=performance.now();
for(let n=0;n<count;n++)old.transaction(()=>{
 const at=base+n*86400000,id=uuid(),first=100000000+n*40;
 old.prepare("INSERT INTO sessions VALUES(?,'owner',?,'platform',?,?,?,'observed')").run(id,String(n),at,at,at+240*minute);
 old.prepare("INSERT INTO platform_streams(platform,account_id,external_id,session_id,started_at_ms,ended_at_ms,last_observed_at_ms) VALUES('twitch','owner',?,?,?,?,?)").run(String(n),id,at,at+240*minute,at+239*minute);
 for(let j=0;j<40;j++){const p=uuid(),i=uuid(),external=String(first+j),name='viewer'+external;people.run(p,name);identity.run(i,external,name,name,p,name);alias.run(i,name,name,at,at);}
 polls.run(id,at,at);members.run(id,String(first),String(first+39));samples.run(id,at);events.run(first,at,at);
 old.prepare('INSERT INTO event_sessions SELECT id,? FROM events WHERE occurred_at_ms>=? AND occurred_at_ms<?').run(id,at,at+240*minute);
 if((n+1)%100===0)console.log(JSON.stringify({seeded:n+1,seconds:Math.round((performance.now()-start)/1000)}));
})();
if(old.prepare('SELECT count(*) missing FROM events WHERE identity_id IS NULL').get().missing)throw Error('FIXTURE_IDENTITY_MISMATCH');
const before=statSync(path).size;old.close();start=performance.now();
const migrated=new StreamStore(path),d=migrated.db;
if(d.prepare('SELECT count(*) n FROM presence_members_compact').get().n!==count*240*40)throw Error('MEMBERSHIP_COUNT_MISMATCH');
d.pragma('wal_checkpoint(TRUNCATE)');d.exec('VACUUM');d.pragma('wal_checkpoint(TRUNCATE)');
console.log(JSON.stringify({migrationSeconds:Math.round((performance.now()-start)/1000),beforeMiB:before/1048576,afterMiB:statSync(path).size/1048576,integrity:d.pragma('integrity_check',{simple:true}),foreignKeys:d.pragma('foreign_key_check').length}));migrated.close();
const client=new StoreClient(path);start=performance.now();let requests=0;
try{
 await client.ready;const q={fromMs:base,toMs:base+(count+1)*86400000,timezone:'Europe/Moscow',ownerId:'owner',summaryOnly:true};let r;
 do{r=await client.call('analytics',q);requests++;if(requests%100===0)console.log(JSON.stringify({requests,ready:r.ready,total:r.total,seconds:Math.round((performance.now()-start)/1000)}));}while(r.preparing);
 console.log(JSON.stringify({observed:r.summary}));
 if(r.summary.streams!==count||r.summary.messages!==count*500||r.summary.entities!==count*40)throw Error('SUMMARY_MISMATCH');
 console.log(JSON.stringify({complete:true,seconds:Math.round((performance.now()-start)/1000),summary:r.summary,page:r.audiencePage}));
 for(const extra of [{audienceOffset:Math.max(0,count*40-100),audienceSort:'messages'},{clockDay:'all',clockMinute:180,clockResolution:60,clockOffset:Math.max(0,count*40-100)}]){
  const t=performance.now(),p=await client.call('analytics',{...q,...extra});
  if(p.clockVisitors&&p.clockVisitors.total!==count*40)throw Error('CLOCK_COUNT_MISMATCH');
  console.log(JSON.stringify({extra,ms:Math.round(performance.now()-t),page:p.audiencePage,clock:p.clockVisitors?{total:p.clockVisitors.total,rows:p.clockVisitors.items.length}:undefined}));
 }
}finally{await client.stop();rmSync(dir,{recursive:true,force:true});}
