import {restoreLegacyPresence} from '../../../packages/core/test/legacy-presence.js';
import {openProfileDatabase} from '../../../packages/core/src/profile-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../../../packages/core/src/store.js';
import {prepareChatStorage} from '../src/chat-cleanup.js';
test('an additive projection migration does not compact or rewrite source storage',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-projection-migration-')),path=join(dir,'data.sqlite');
 try{
  const store=new StreamStore(path,'ruslan');store.startSession('owner','retained',1,'platform',1);store.close();
  const db=new Database(path);db.prepare("UPDATE sp_profile_schema SET version=21 WHERE profile='ruslan'").run();db.close();
  const before=await readFile(path);assert.equal(await prepareChatStorage(path),undefined);assert.deepEqual(await readFile(path),before);
  const reopened=new StreamStore(path,'ruslan');assert.equal(reopened.sessions().length,1);reopened.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('old chat content is scrubbed and compacted for both profiles without changing counts, identities or donations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-chat-cleanup-')),path=join(dir,'data.sqlite'),at=1791954000000;
 const marker='DO_NOT_KEEP_THIS_CHAT_TEXT';
 const expected=new Map<string,{summary:any;analytics:any;person:any;stream:string}>();
 try{
  for(const profile of ['ruslan','gulnaz']){
   const store=new StreamStore(path,profile);
   const stream=store.startSession('owner','live',at,'platform',at);
   let person:string|null=null;
   for(let i=0;i<150;i++)person=store.ingest({source:'twitch',accountId:'owner',externalId:`m-${i}`,type:'chat.message',actor:{externalId:'viewer',displayName:`Viewer ${profile}`},occurredAtMs:at+i*1000,receivedAtMs:at+i*1000,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:marker,raw:{message:{text:marker}}}}).personId;
   store.attachPlatformStream(stream,'youtube','yt-owner','yt-live',at,at,null,'Live');
   store.youtubeMessages('yt-owner','chat',[{id:'yt-message',snippet:{type:'textMessageEvent',publishedAt:new Date(at).toISOString(),displayMessage:marker,textMessageDetails:{messageText:marker}},authorDetails:{channelId:'yt-viewer',displayName:`YT ${profile}`}}]);
   store.createDonation({personId:person!,sourceName:'Manual',occurredAtMs:at+1000,currency:'RUB',amount:'228',message:'Keep donation text'},at+1000);
   store.endSession(stream,at+180000);
   expected.set(profile,{summary:store.summary(stream),analytics:store.analytics({fromMs:at,toMs:at+180000,sessionId:stream,youtubeAccount:'yt-owner'}),person:store.person(person!,false),stream});
   store.close();
  }
  const old=new Database(path);
  for(const profile of ['ruslan','gulnaz']){
   old.prepare(`UPDATE p_${profile}_events SET payload_json=? WHERE type='chat.message'`).run(JSON.stringify({text:marker.repeat(100),raw:{message:{text:marker.repeat(100)}}}));
   old.prepare(`UPDATE p_${profile}_youtube_messages SET payload_json=json_set(payload_json,'$.snippet.displayMessage',?)`).run(marker.repeat(100));
   old.prepare(`INSERT INTO p_${profile}_provider_snapshots VALUES (?,?,?,?,?,?,?)`).run(`raw-${profile}`,'youtube','yt-owner','chat:chat',at,null,JSON.stringify([{text:marker.repeat(10000)}]));
   const legacy=openProfileDatabase(path,profile);restoreLegacyPresence(legacy);legacy.close();
   old.prepare('UPDATE sp_profile_schema SET version=14 WHERE profile=?').run(profile);
  }
  old.pragma('wal_checkpoint(TRUNCATE)');old.close();
  const report=await prepareChatStorage(path);
  assert.equal(report!.compacted,true);assert.ok(report!.afterBytes<report!.beforeBytes);
  for(const profile of ['ruslan','gulnaz']){
   const store=new StreamStore(path,profile),before=expected.get(profile)!;
   assert.deepEqual(store.summary(before.stream),before.summary);
   assert.deepEqual(store.analytics({fromMs:at,toMs:at+180000,sessionId:before.stream,youtubeAccount:'yt-owner'}),before.analytics);
   assert.deepEqual(store.person(String(before.person.id),false),before.person);
   assert.equal(store.ingest({source:'twitch',accountId:'owner',externalId:'m-1',type:'chat.message',actor:{externalId:'viewer',displayName:`Viewer ${profile}`},occurredAtMs:at+1000,receivedAtMs:at+1000,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:marker}}).inserted,false);
   store.close();
  }
  assert.equal((await readFile(path)).includes(Buffer.from(marker)),false,'compaction must remove obsolete text from SQLite pages');
  assert.equal(await prepareChatStorage(path),undefined,'cleanup does not VACUUM every startup');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('new observations discard nested content and direct raw chat snapshots while preserving counters',()=>{
 const store=new StreamStore(':memory:');
 try{
  const result=store.ingest({source:'twitch',accountId:'owner',externalId:'m',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:1,receivedAtMs:1,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'discard',raw:{nested:'discard'},fragments:[{text:'discard'}],originChannelId:'owner'}});
  assert.deepEqual(store.events()[0]!.payload,{count:1,originChannelId:'owner'});
  assert.equal(store.summary().messages,1);assert.equal(store.personStats(result.personId!).messageCount,1);
  store.youtubeMessages('yt-owner','chat',[{id:'yt',snippet:{type:'textMessageEvent',publishedAt:'2026-10-14T10:00:00Z',displayMessage:'discard'},authorDetails:{channelId:'viewer',displayName:'Viewer'}}]);
  store.youtubeSnapshot('yt-owner','chat:chat',{text:'discard'});
  store.providerSnapshot('youtube','yt-owner','chat:chat',{text:'discard'},1);
  assert.equal(JSON.stringify(store.youtubeData('yt-owner')).includes('discard'),false);
 }finally{store.close();}
});
