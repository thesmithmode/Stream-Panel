import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {StreamStore} from '../../../packages/core/src/store.js';import {normalizeDonation} from '../src/donationalerts.js';import {prepareChatStorage} from '../src/chat-cleanup.js';
const at=Date.parse('2026-10-10T12:00:00Z');
const donation=(id:number|string)=>({id,amount:'1',currency:'RUB',username:'Original',message:'Keep actual donation',created_at:'2026-10-10 12:00:00'});
test('diagnostic cleanup preserves missing donations, follower history and both profile ledgers before deleting old pages',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-provider-migration-')),path=join(dir,'data.sqlite'),before=new Map<string,any>();
 try{
  for(const profile of ['ruslan','gulnaz']){
   const s=new StreamStore(path,profile);s.ingest(normalizeDonation(donation(1),'owner','rest'));
   s.ingest(normalizeDonation({...donation(2),created_at:''},'owner','rest'));
   const person=s.ingest({source:'twitch',accountId:'owner',externalId:'viewer-message',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{}}).personId!;
   s.followingSnapshot('twitch','owner',[{id:'viewer',name:'Viewer',followedAtMs:at-1000}],true,at,1);
   before.set(profile,{events:s.events(),following:s.personFollowing(person),person});s.close();
  }
  const db=new Database(path);
  for(const profile of ['ruslan','gulnaz']){
   const insert=db.prepare(`INSERT INTO p_${profile}_provider_snapshots VALUES (?,?,?,?,?,?,?)`);
   insert.run(`page-${profile}`,'donationalerts','owner','donation_history_page',at,null,JSON.stringify({response:{data:[donation(1),donation(2),donation(3),{...donation(4),amount:'bad'}]}}));
   insert.run(`notification-${profile}`,'donationalerts','owner','donation_notification',at,null,JSON.stringify({data:'{"id":9007199254740993,"amount":0.29,"currency":"RUB","created_at":"2026-10-10 12:00:00"}'}));
   insert.run(`chatter-${profile}`,'twitch','owner','chatters',at,null,JSON.stringify({users:['UNUSED_DIAGNOSTIC_CONTENT']}));
   db.prepare(`UPDATE p_${profile}_provider_snapshots SET payload_json=json_set(payload_json,'$.followers[0].raw',json(?)) WHERE key='followers'`).run('{"unused":"UNUSED_DIAGNOSTIC_CONTENT"}');
   db.prepare('UPDATE sp_profile_schema SET version=15 WHERE profile=?').run(profile);
  }
  db.pragma('wal_checkpoint(TRUNCATE)');db.close();
  const report=await prepareChatStorage(path);assert.equal(report!.compacted,true);
  for(const profile of ['ruslan','gulnaz']){
   const s=new StreamStore(path,profile);assert.deepEqual(s.events(),before.get(profile).events);assert.deepEqual(s.personFollowing(before.get(profile).person),before.get(profile).following);
   const pending=s.pendingDonationImports('owner');assert.equal(pending.length,4,'unknown ID, missing timestamp, malformed row and exact large ID survive');
   assert.ok(pending.some(row=>row.serialized.includes('9007199254740993')));
   assert.ok(!pending.some(row=>JSON.parse(row.serialized).id===1||JSON.parse(row.serialized).id==='1'));
   const raw=new Database(path,{readonly:true});assert.equal((raw.prepare(`SELECT count(*) AS n FROM p_${profile}_provider_snapshots WHERE key NOT IN('followers','donation_unparsed')`).get() as {n:number}).n,0);raw.close();s.close();
  }
  assert.equal((await readFile(path)).includes(Buffer.from('UNUSED_DIAGNOSTIC_CONTENT')),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
