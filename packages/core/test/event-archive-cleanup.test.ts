import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';
import {openProfileDatabase} from '../src/profile-db.js';
import {CURRENT_SCHEMA_VERSION} from '../src/schema.js';

test('archive cleanup upgrades both profiles atomically while retaining chat counts, donations, categories and lifecycle',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-archive-cleanup-')),path=join(dir,'data.sqlite');
 try{
 for(const profile of ['ruslan','gulnaz']){
  const store=new StreamStore(path,profile),at=100000;
  const sid=store.observePlatformStream('twitch','owner','live',at,at,null,'Title')!;
  store.ingest({source:'twitch',accountId:'owner',externalId:'chat',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'secret'}});
  store.ingest({source:'donationalerts',accountId:'da',externalId:'tip',type:'donation',actor:null,occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'rest',payload:{amountMinor:'22800',currency:'RUB'}});
  store.streamSample(sid,at,'game','Game','Title',5);store.close();
  const db=openProfileDatabase(path,profile);
  for(const type of ['goal.begin','chat.notification','stream.offline']){
   db.prepare('INSERT INTO events VALUES (?,?,?,?,?,NULL,?,?,NULL,?,?,?)').run(type,'twitch','owner',type,type,at,at,'provider','eventsub',JSON.stringify({raw:{text:'trash'}}));
   db.prepare('INSERT INTO event_sessions VALUES (?,?)').run(type,sid);
  }
  db.exec('PRAGMA user_version=18;');db.close();
 }
 for(const profile of ['ruslan','gulnaz']){
  const store=new StreamStore(path,profile);
  assert.equal(store.events().length,2);assert.equal(store.summary().messages,1);assert.equal((store.summary().totals as Record<string,string>).RUB,'22800');
  const sid=String(store.sessions()[0]!.id);assert.equal(store.platformStreams(sid).length,1);assert.equal((store.streamMetadata(sid)[0] as {categoryName:string})?.categoryName,'Game');store.close();
  const db=openProfileDatabase(path,profile);assert.equal(db.pragma('user_version',{simple:true}),CURRENT_SCHEMA_VERSION);assert.deepEqual(db.pragma('foreign_key_check'),[]);db.close();
 }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
