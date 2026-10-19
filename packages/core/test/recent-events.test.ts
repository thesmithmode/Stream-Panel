import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';
import {openProfileDatabase} from '../src/profile-db.js';
import {RecentEvents,EVENT_RETENTION_MS,EVENT_CLEANUP_BATCH} from '../src/recent-events.js';
import type {EventInput} from '../src/domain.js';

const message=(id:string,at=Date.now()-1000):EventInput=>({source:'twitch',accountId:'owner',externalId:id,type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'Привет 👋',raw:{huge:'transport envelope'}}});
test('recent content is deduplicated and expiry never removes permanent facts or revisions',()=>{
 const s=new StreamStore(':memory:');
 try{
  const at=Date.now()-1000;
  s.startSession('owner','live',at-1000,'manual',at-1000);
  const event=message('one',at);s.ingest(event);s.ingest(event);
  assert.equal(s.recentEvents().length,1);assert.equal(s.recentEvents()[0]!.payload.text,'Привет 👋');assert.equal(s.recentEvents()[0]!.payload.raw,undefined);
  assert.equal(JSON.stringify(s.events()).includes('Привет'),false);
  const db=(s as unknown as {db:ReturnType<typeof openProfileDatabase>}).db,archive=new RecentEvents(db);
  const revisions=db.prepare('SELECT * FROM analytics_stream_revisions').all(),global=db.prepare('SELECT * FROM analytics_global_revision').all();
  assert.equal(archive.list(0,100,at+EVENT_RETENTION_MS-1).length,1);
  assert.equal(archive.list(0,100,at+EVENT_RETENTION_MS).length,0);
  assert.equal(archive.purge(at+EVENT_RETENTION_MS),1);
  assert.equal(s.events().length,1);assert.equal(s.summary().messages,1);
  assert.deepEqual(db.prepare('SELECT * FROM analytics_stream_revisions').all(),revisions);assert.deepEqual(db.prepare('SELECT * FROM analytics_global_revision').all(),global);
  s.ingest(event);assert.equal(s.recentEvents().length,0,'duplicate cannot resurrect text');
  s.ingest(message('old',Date.now()-EVENT_RETENTION_MS-1));assert.equal(s.recentEvents().length,0,'old REST event is counted without retaining expired text');
  assert.throws(()=>s.recentEvents(-1),/INVALID_RECENT/);assert.throws(()=>s.recentEvents(0,201),/INVALID_RECENT/);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
 }finally{s.close();}
});
test('cleanup is indexed, bounded and excludes the other profile after restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-recent-')),path=join(dir,'data.sqlite'),at=Date.now()-1000;
 try{
  for(const profile of ['ruslan','gulnaz']){const s=new StreamStore(path,profile);s.ingest(message('same-id',at));s.close();}
  const db=openProfileDatabase(path,'ruslan'),archive=new RecentEvents(db);
  db.transaction(()=>{for(let i=0;i<EVENT_CLEANUP_BATCH+3;i++)archive.save(message(`batch-${i}`,at),at);})();
  const query=db.prepare('EXPLAIN QUERY PLAN SELECT id FROM recent_events WHERE at_ms<=? ORDER BY at_ms,id LIMIT ?').all(at,500);
  assert.match(JSON.stringify(query),/recent_events_time/);
  assert.equal(archive.purge(at+EVENT_RETENTION_MS),500);assert.equal(archive.purge(at+EVENT_RETENTION_MS),4);assert.equal(archive.purge(at+EVENT_RETENTION_MS),0);db.close();
  const other=new StreamStore(path,'gulnaz');assert.equal(other.recentEvents().length,1);other.close();
  const mine=new StreamStore(path,'ruslan');assert.equal(mine.recentEvents().length,0);assert.equal(mine.summary().messages,1);mine.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Twitch moderation redacts recent messages, including deletion arriving first',()=>{
 const s=new StreamStore(':memory:');try{
  const at=Date.now()-5000;
  s.ingest(message('one',at));
  s.ingest({...message('delete',at+1000),type:'chat.message_delete',actor:null,payload:{targetMessageId:'one'}});
  assert.equal(s.recentEvents().find(r=>r.external_id==='one')!.payload.text,'');
  s.ingest({...message('delete-first',at+2000),type:'chat.message_delete',actor:null,payload:{targetMessageId:'two'}});
  s.ingest(message('two',at));assert.equal(s.recentEvents().find(r=>r.external_id==='two')!.payload.text,'');
  s.ingest(message('three',at));
  s.ingest({...message('clear-user',at+3000),type:'chat.clear_user_messages',actor:null,payload:{targetUserId:'viewer'}});
  assert.equal(s.recentEvents().find(r=>r.external_id==='three')!.payload.text,'');
  s.ingest({...message('four',at),actor:{externalId:'other',displayName:'Other'}});
  s.ingest({...message('clear',at+4000),type:'chat.clear',actor:null,payload:{}});
  assert.equal(s.recentEvents().find(r=>r.external_id==='four')!.payload.text,'');
 }finally{s.close();}
});
test('YouTube retains compact text, deduplicates, separates accounts and honors moderation',()=>{
 const s=new StreamStore(':memory:');try{
  const at=Date.now()-1000,m={id:'yt',snippet:{type:'textMessageEvent',publishedAt:new Date(at).toISOString(),displayMessage:'YouTube text'},authorDetails:{channelId:'viewer',displayName:'Viewer'}};
  s.youtubeMessages('yt-owner','chat',[m,m]);s.youtubeMessages('other-owner','other-chat',[{...m,id:'yt-other'}]);
  assert.equal(s.recentEvents().length,2);assert.equal(s.recentEvents()[0]!.payload.text,'YouTube text');
  assert.equal(JSON.stringify(s.youtubeData('yt-owner')).includes('YouTube text'),false);
  s.youtubeMessages('yt-owner','chat',[{...m,id:'delete',snippet:{...m.snippet,type:'messageDeletedEvent',messageDeletedDetails:{deletedMessageId:'yt'}}}]);
  assert.equal(s.recentEvents().filter(r=>r.external_id==='yt').length,0);
  assert.equal(s.recentEvents().filter(r=>r.external_id==='yt-other').length,1);
  s.youtubeMessages('other-owner','other-chat',[{...m,id:'ban',snippet:{...m.snippet,type:'userBannedEvent',userBannedDetails:{bannedUserDetails:{channelId:'viewer'}}}}]);
  assert.equal(s.recentEvents().filter(r=>r.external_id==='yt-other').length,0);
 }finally{s.close();}
});
