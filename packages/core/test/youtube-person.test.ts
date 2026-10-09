import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
const at=Date.UTC(2026,9,9,12), minute=60000;
const message=(id:string,author:string,name:string,time=at)=>({id,snippet:{type:'textMessageEvent',publishedAt:new Date(time).toISOString(),displayMessage:'hello'},authorDetails:{channelId:author,displayName:name}});
function twitch(store:StreamStore){return store.ingest({source:'twitch',accountId:'owner',externalId:'tw-message',type:'chat.message',actor:{externalId:'viewer',displayName:'SameName'},occurredAtMs:at,receivedAtMs:at,sourceTime:new Date(at).toISOString(),timeQuality:'provider',transport:'eventsub',payload:{text:'twitch'}}).personId!;}

test('YouTube authors become independent Person records and ambiguous nicknames never auto-link',()=>{
 const s=new StreamStore(':memory:');try{
  const tw=twitch(s);s.youtubeMessages('channel','chat',[message('yt-message','author','SameName')]);
  const people=s.persons(),yt=people.find(p=>p.id!==tw)!;assert.equal(people.length,2);
  assert.equal(yt.sources,'youtube');assert.equal(yt.display_name,'SameName');
  const detail=s.person(String(yt.id));assert.equal((detail.identities as any[])[0].source,'youtube');
  assert.equal(s.events(undefined,String(yt.id))[0]!.source,'youtube');
  s.youtubeMessages('channel','chat',[message('yt-message','author','SameName')]);assert.equal(s.persons().length,2);
 }finally{s.close();}
});

test('manual merge/split and undo include YouTube membership without moving or duplicating raw messages',()=>{
 const s=new StreamStore(':memory:');try{
  const tw=twitch(s);s.youtubeMessages('channel','chat',[message('yt-message','author','YouTube name')]);
  const yt=s.persons().find(p=>p.id!==tw)!;const yi=(s.person(String(yt.id)).identities as any[])[0];
  s.createPersonNote(String(yt.id),'YouTube note',at);s.setPersonMetadata(String(yt.id),['youtube-tag'],true,s.personRevision(String(yt.id)));
  const merge=s.merge(String(yt.id),tw,s.personRevision(String(yt.id)),s.personRevision(tw),at);
  assert.equal((s.person(tw).identities as any[]).length,2);assert.equal(s.events(undefined,tw).length,2);
  assert.equal(s.personNotes(tw).length,1);assert.deepEqual(s.personMetadata(tw).tags,['youtube-tag']);
  s.undoMerge(merge,at+1);assert.equal(s.events(undefined,tw).length,1);assert.equal(s.events(undefined,String(yt.id)).length,1);
  const split=s.splitIdentities([yi.id],'Separate YouTube',s.personRevision(String(yt.id)),at+2);
  assert.equal(s.events(undefined,split).length,1);assert.equal(s.youtubeData('channel').messages.length,1);
 }finally{s.close();}
});

test('linked YouTube activity shares person analytics and metadata while keeping observed and inferred time distinct',()=>{
 const s=new StreamStore(':memory:');try{
  const session=s.observePlatformStream('youtube','channel','video',at,at,null,'Stream')!;
  s.observePlatformStream('twitch','owner','stream',at,at,null,'Stream');const tw=twitch(s);
  s.youtubeMessages('channel','chat',[message('yt-message','author','YouTube name',at+minute)]);
  const yt=s.persons().find(p=>p.id!==tw)!;s.merge(String(yt.id),tw,s.personRevision(String(yt.id)),s.personRevision(tw),at+minute);
  s.setPersonMetadata(tw,['linked'],true,s.personRevision(tw));s.endSession(session,at+3*minute);
  const result=s.analytics({fromMs:at,toMs:at+3*minute,youtubeAccount:'channel'});
  assert.equal(result.audience.length,1);assert.equal(result.audience[0]!.id,tw);assert.equal(result.audience[0]!.messages,2);
  assert.equal(result.audience[0]!.core,true);assert.deepEqual(result.audience[0]!.tags,['linked']);
  assert.equal(s.personStats(tw).messageCount,2);assert.equal(s.personStats(tw).totalObservedMinutes,0);
  assert.ok(Number(s.personStats(tw).estimatedChatMinutes)>0);
 }finally{s.close();}
});

test('YouTube chat outside a confirmed YouTube broadcast stays raw and never inherits a Twitch-only stream',()=>{
 const s=new StreamStore(':memory:');try{
  s.observePlatformStream('twitch','owner','stream',at,at,null,'Twitch only');
  s.youtubeMessages('channel','chat',[message('unconfirmed','author','Viewer',at+minute)]);
  const person='youtube:author';
  assert.equal(s.analytics({fromMs:at,toMs:at+3*minute,youtubeAccount:'channel'}).summary.entities,0);
  assert.equal(s.personStats(person).messageCount,1);
  assert.equal(s.personStats(person).sessionsWithAttendance,0);
  assert.equal(s.personStats(person).estimatedChatMinutes,0);
  assert.equal(s.events(undefined,person)[0]!.session_id,null);
  assert.equal(s.youtubeData('channel').messages.length,1);
 }finally{s.close();}
});

test('YouTube owner flags, channel IDs and former bot aliases exclude personal aggregates without deleting raw events',()=>{
 const s=new StreamStore(':memory:');try{
  s.observePlatformStream('youtube','channel','video',at,at,null,'YouTube');
  s.youtubeMessages('channel','chat',[
   message('own-id','channel','Renamed owner'),
   {...message('owner-flag','different-owner','Other owner'),authorDetails:{channelId:'different-owner',displayName:'Other owner',isChatOwner:true}},
   message('bot-before','bot','StreamElements'),message('bot-after','bot','NewName',at+minute)
  ]);
  for(const id of ['channel','different-owner','bot']){
   assert.equal(s.personStats(`youtube:${id}`).messageCount,0);
   assert.equal(s.personStats(`youtube:${id}`).estimatedChatMinutes,0);
   assert.equal(s.persons().find(p=>p.id===`youtube:${id}`)!.is_bot,1);
  }
  assert.equal(s.analytics({fromMs:at,toMs:at+3*minute,youtubeAccount:'channel'}).summary.entities,0);
  assert.equal(s.youtubeData('channel').messages.length,4);
 }finally{s.close();}
});

test('common message ranking includes standalone YouTube authors and sums manually linked memberships',()=>{
 const s=new StreamStore(':memory:');try{
  const session=s.observePlatformStream('youtube','channel','video',at,at,null,'YouTube')!;
  const tw=twitch(s);
  s.youtubeMessages('channel','chat',[message('a','author','Author'),message('b','author','Author',at+minute),message('c','other','Other',at+minute)]);
  assert.equal(s.personsTop('messages',session)[0]!.id,'youtube:author');
  assert.equal(s.personsTop('messages',session)[0]!.messageCount,2);
  s.merge('youtube:author',tw,s.personRevision('youtube:author'),s.personRevision(tw),at+minute);
  const top=s.personsTop('messages');assert.equal(top[0]!.id,tw);assert.equal(top[0]!.messageCount,3);
  assert.equal(top[0]!.sources,'twitch,youtube');
 }finally{s.close();}
});

test('lifetime observed ranking includes streams beyond the former twenty-stream cap',()=>{
 const s=new StreamStore(':memory:');try{
  const person=twitch(s);
  for(let n=0;n<25;n++){
   const start=at+n*10*minute,session=s.observePlatformStream('twitch','owner',`video-${n}`,start,start,null,'Stream')!;
   s.recordPoll(session,'owner',{startedAtMs:start,completedAtMs:start+minute,status:'complete',userIds:['viewer']});
   s.endSession(session,start+minute);
  }
  const row=s.personsTop('observed_minutes')[0]!;
  assert.equal(row.id,person);assert.equal(row.observedMinutes,25);
 }finally{s.close();}
});
