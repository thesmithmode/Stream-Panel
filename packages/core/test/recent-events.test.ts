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
test('filtered archive follows current person links and logical stream groups without mixing accounts or concurrent YouTube chats',()=>{
 const s=new StreamStore(':memory:');try{
  const at=Date.now()-600000,a=s.startSession('owner','a',at,'platform',at);
  s.attachPlatformStream(a,'youtube','yt','video-a',at,at,null,'A');s.ingest(message('a',at+1000));s.endSession(a,at+60000);
  const b=s.startSession('owner','b',at+120000,'platform',at+120000);s.ingest({...message('b',at+121000),actor:{externalId:'other',displayName:'Other'}});s.endSession(b,at+180000);
  const people=s.persons(),viewer=String(people.find(p=>p.display_name==='Viewer')!.id),other=String(people.find(p=>p.display_name==='Other')!.id);
  assert.deepEqual(s.recentEvents(0,100,{session:a}).map(r=>r.external_id),['a']);
  assert.deepEqual(s.recentEvents(0,100,{person:viewer,messagesOnly:true}).map(r=>r.external_id),['a']);
  assert.equal(s.recentEvents(0,100,{session:a})[0]!.person_id,viewer);
  const merged=s.merge(viewer,other,s.personRevision(viewer),s.personRevision(other),at+200000);
  assert.equal(s.recentEvents(0,100,{person:other,messagesOnly:true}).length,2);
  assert.ok(s.recentEvents().every(row=>row.person_id===other));s.undoMerge(merged,at+210000);
  assert.equal(s.recentEvents().find(row=>row.external_id==='a')!.person_id,viewer);
  assert.equal(s.recentEvents(0,100,{person:other,messagesOnly:true}).length,1);
  s.mergeSessions([a,b]);assert.equal(s.recentEvents(0,100,{session:b}).length,2);s.unmergeSessions(a);assert.equal(s.recentEvents(0,100,{session:b}).length,1);
  const c=s.startSession('concurrent','c',at,'platform',at);s.attachPlatformStream(c,'youtube','yt','video-b',at,at,null,'B');s.endSession(c,at+60000);
  const yt=(id:string)=>[{id,snippet:{type:'textMessageEvent',publishedAt:new Date(at+1000).toISOString(),displayMessage:id},authorDetails:{channelId:'yt-viewer',displayName:'YouTube'}}];
  s.youtubeMessages('yt','chat-a',yt('ya'),'video-a');s.youtubeMessages('yt','chat-b',yt('yb'),'video-b');s.youtubeMessages('yt','legacy',yt('ambiguous'));
  const ytPerson=s.recentEvents().find(row=>row.external_id==='ya')!.person_id;assert.ok(ytPerson);
  assert.equal(s.person(ytPerson).display_name,'YouTube');
  const rows=s.recentEvents(0,100,{session:a});assert.ok(rows.some(r=>r.external_id==='ya'));assert.ok(!rows.some(r=>['yb','ambiguous'].includes(r.external_id)));
  assert.equal(s.recentEvents(0,100,{session:'missing'}).length,0);assert.throws(()=>s.recentEvents(0,100,{person:'x'.repeat(257)}),/INVALID_RECENT_EVENTS_FILTER/);
 }finally{s.close();}
});
test('archive resolves exact account authors after splits and leaves unlinked or anonymous rows plain',()=>{
 const s=new StreamStore(':memory:');try{
  const at=Date.now()-10000;
  const a=s.ingest(message('one',at)).personId!;
  const b=s.ingest({...message('two',at+1000),accountId:'other-owner',actor:{externalId:'other-id',displayName:'Viewer'}}).personId!;
  s.ingest({...message('no-author',at+2000),type:'chat.clear',actor:null});
  assert.equal(s.recentEvents().find(row=>row.external_id==='no-author')!.person_id,null);
  // One Twitch ID initially shares a person across channels; a selective split then separates the rows.
  const c=s.ingest({...message('three',at+3000),accountId:'third-owner',actor:{externalId:'viewer',displayName:'Another viewer'}}).personId!;
  assert.equal(c,a);
  const merged=s.merge(a,b,s.personRevision(a),s.personRevision(b),at+4000);
  const identity=(s.person(b).identities as {id:string;external_id:string}[]).find(i=>i.external_id==='viewer')!;
  const split=s.splitIdentities([identity.id],'Separate',s.personRevision(b),at+5000);
  assert.equal(s.recentEvents().find(row=>row.external_id==='one')!.person_id,split);
  assert.equal(s.recentEvents().find(row=>row.external_id==='two')!.person_id,b);
  assert.equal(s.recentEvents().find(row=>row.external_id==='three')!.person_id,b);
  assert.ok(merged);
 }finally{s.close();}
});
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
for (const type of ['chat.message_delete', 'chat.clear_user_messages', 'chat.clear']) {
 test(`Twitch archive preserves messages across ${type}, delivery order and restart`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-moderated-archive-'));
  const path = join(dir, 'data.sqlite');
  const at = Date.now() - 10_000;
  const text = 'Привет 👋\n  <сообщение>  ';
  const before = {...message('before', at), payload: {text}};
  const after = {...message('after', at + 1), payload: {text}};
  const notice = (targetMessageId: string): EventInput => ({
   ...message(`moderation-${targetMessageId}`, at + 1000),
   type,
   actor: null,
   payload: {targetMessageId, targetUserId: 'viewer'},
  });
  try {
   const writer = new StreamStore(path);
   try {
    writer.ingest(before);
    writer.ingest(notice('before'));
    if (type === 'chat.message_delete') writer.ingest(notice('after'));
   } finally { writer.close(); }

   const reader = new StreamStore(path);
   try {
    reader.ingest(after);
    assert.equal(reader.ingest({...before, payload: {text: 'duplicate'}}).inserted, false);
    assert.equal(reader.ingest(notice('before')).inserted, false);
    const rows = reader.recentEvents();
    assert.equal(rows.filter(row => row.type === type).length, type === 'chat.message_delete' ? 2 : 1);
    const messages = rows.filter(row => row.type === 'chat.message');
    assert.equal(messages.length, 2);
    for (const original of [before, after]) {
     const row = messages.find(item => item.external_id === original.externalId)!;
     assert.equal(row.payload.text, text);
     assert.equal(row.actor_id, 'viewer');
     assert.equal(row.at_ms, original.occurredAtMs);
     const permanent = reader.events().find(item => item.external_id === original.externalId)!;
     assert.equal(permanent.payload.redacted, 1);
     assert.equal(permanent.payload.text, undefined);
    }
   } finally { reader.close(); }
  } finally { rmSync(dir, {recursive: true, force: true}); }
 });
}
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
