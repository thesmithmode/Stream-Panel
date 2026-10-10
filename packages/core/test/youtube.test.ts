import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';
test('YouTube reports, duplicate messages, moderation, account and profile isolation, persistent quota',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-yt-core-')),path=join(dir,'data.sqlite');
 const a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz');
 try{
  assert.throws(()=>a.youtubeQuota('wrong','ruslan'),/INVALID_QUOTA/);
  assert.equal(a.youtubeQuota('10/07/2026','ruslan',4000),true);assert.equal(a.youtubeQuota('10/07/2026','ruslan'),false);
  assert.equal(b.youtubeQuota('10/07/2026','gulnaz',4000),true);assert.equal(b.youtubeQuota('10/07/2026','ruslan'),false);
  assert.equal(a.youtubeQuota('10/08/2026','ruslan'),true);
  assert.throws(()=>a.youtubeSnapshot('','key',{}),/INVALID_YOUTUBE_KEY/);assert.throws(()=>a.youtubeMessages('','chat',[]),/INVALID_YOUTUBE_MESSAGES/);
  a.youtubeSnapshot('channel','report',{views:42});a.youtubeSnapshot('channel','report',{views:43});
  const message={id:'same',snippet:{type:'textMessageEvent',publishedAt:'2026-10-07T12:00:00Z',displayMessage:'A'},authorDetails:{channelId:'viewer'}};
  a.youtubeMessages('channel','chat',[message,message,{id:'bad',snippet:{publishedAt:'invalid'}}]);
  b.youtubeMessages('channel','chat',[{...message,snippet:{...message.snippet,displayMessage:'B'}}]);
  assert.equal(a.youtubeData('channel').messages.length,1);assert.equal(a.youtubeData('channel').snapshots.report!.data.views,43);
  assert.equal(b.youtubeData('channel').messages[0].snippet.displayMessage,'B');assert.equal(a.youtubeData('other').messages.length,0);
  a.youtubeMessages('channel','chat',[{id:'delete',snippet:{type:'messageDeletedEvent',publishedAt:message.snippet.publishedAt,messageDeletedDetails:{deletedMessageId:'same'}}}]);
  assert.equal(a.youtubeData('channel').messages.some(m=>m.id==='same'),false);
  a.youtubeMessages('channel','chat',[message,{id:'ban',snippet:{type:'userBannedEvent',publishedAt:message.snippet.publishedAt,userBannedDetails:{bannedUserDetails:{channelId:'viewer'}}}}]);
  assert.equal(a.youtubeData('channel').messages.some(m=>m.id==='same'),false);
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

test('YouTube moderation with missing or malformed target IDs preserves messages and audit rows',()=>{
 const store=new StreamStore(':memory:');
 try {
  const message={id:'kept',snippet:{type:'textMessageEvent',publishedAt:'2026-10-07T12:00:00Z',displayMessage:'Keep me'},authorDetails:{channelId:'viewer'}};
  const anonymous={id:'anonymous',snippet:{type:'textMessageEvent',publishedAt:'2026-10-07T12:00:00Z',displayMessage:'Anonymous'}};
  store.youtubeMessages('channel','chat',[message,anonymous]);
  store.youtubeMessages('channel','chat',[
   {id:'delete-no-target',snippet:{type:'messageDeletedEvent',publishedAt:message.snippet.publishedAt}},
   {id:'delete-empty-target',snippet:{type:'messageDeletedEvent',publishedAt:message.snippet.publishedAt,messageDeletedDetails:{deletedMessageId:''}}},
   {id:'delete-malformed-target',snippet:{type:'messageDeletedEvent',publishedAt:message.snippet.publishedAt,messageDeletedDetails:{deletedMessageId:42}}},
   {id:'ban-no-target',snippet:{type:'userBannedEvent',publishedAt:message.snippet.publishedAt}},
   {id:'ban-empty-target',snippet:{type:'userBannedEvent',publishedAt:message.snippet.publishedAt,userBannedDetails:{bannedUserDetails:{channelId:''}}}},
   {id:'ban-malformed-target',snippet:{type:'userBannedEvent',publishedAt:message.snippet.publishedAt,userBannedDetails:{bannedUserDetails:{channelId:42}}}},
  ]);
  const messages=store.youtubeData('channel').messages;
  const kept=messages.find(row=>row.id==='kept')!;
  assert.equal(kept.snippet.displayMessage,'Keep me');
  assert.equal(messages.some(row=>row.id==='anonymous'),true);
  for(const id of ['delete-no-target','delete-empty-target','delete-malformed-target'])
   assert.equal(messages.find(row=>row.id===id)?.snippet.type,'messageDeletedEvent');
  for(const id of ['ban-no-target','ban-empty-target','ban-malformed-target'])
   assert.equal(messages.find(row=>row.id===id)?.snippet.type,'userBannedEvent');
 } finally {store.close();}
});
