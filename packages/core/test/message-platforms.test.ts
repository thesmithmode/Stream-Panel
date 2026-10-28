import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
const at=Date.UTC(2026,9,13,9),m=60000;
test('messages split by platform and mutually exclusive core, subscribers, non-subscribers and unknown status',()=>{
 const s=new StreamStore(':memory:');try{
  const sid=s.observePlatformStream('twitch','owner','one',at,at,null,'Stream')!;
  s.observePlatformStream('youtube','ytowner','video',at,at,null,'Stream');
  const twitch=(id:string,n:number)=>{
   let person='';for(let i=0;i<n;i++)person=s.ingest({source:'twitch',accountId:'owner',externalId:`${id}-${i}`,type:'chat.message',actor:{externalId:id,displayName:id},occurredAtMs:at+m,receivedAtMs:at+m,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:id}}).personId!;
   return person;
  };
  const core=twitch('core',2),follower=twitch('follower',3),casual=twitch('casual',4);
  s.setPersonMetadata(follower,[],false,s.personRevision(follower));s.setPersonMetadata(casual,[],false,s.personRevision(casual));
  s.setPersonMetadata(core,[],true,s.personRevision(core));
  s.followingSnapshot('twitch','owner',[{id:'core',name:'core',followedAtMs:null},{id:'follower',name:'follower',followedAtMs:null}],true,at+2*m);
  s.youtubeMessages('ytowner','chat',[{id:'ytcore',snippet:{type:'textMessageEvent',publishedAt:new Date(at+m).toISOString(),displayMessage:'core'},authorDetails:{channelId:'ytcore',displayName:'ytcore'}},{id:'ytf',snippet:{type:'textMessageEvent',publishedAt:new Date(at+m).toISOString(),displayMessage:'subscriber'},authorDetails:{channelId:'ytf',displayName:'ytf'}},{id:'ytunknown',snippet:{type:'textMessageEvent',publishedAt:new Date(at+m).toISOString(),displayMessage:'private'},authorDetails:{channelId:'ytunknown',displayName:'ytunknown'}}]);
  const ytcore=String(s.persons().find(x=>x.display_name==='ytcore')!.id);
  s.setPersonMetadata(ytcore,[],true,s.personRevision(ytcore));
  const ytf=String(s.persons().find(x=>x.display_name==='ytf')!.id);s.setPersonMetadata(ytf,[],false,s.personRevision(ytf));
  s.followingSnapshot('youtube','ytowner',[{id:'ytf',name:'ytf',followedAtMs:null}],true,at+2*m);
  // A Twitch follower merged with a private YouTube account is still unknown on YouTube.
  const unknown=String(s.persons().find(x=>x.display_name==='ytunknown')!.id);
  s.merge(unknown,follower,s.personRevision(unknown),s.personRevision(follower),at+2*m);
  s.endSession(sid,at+3*m);
  const options={fromMs:at,toMs:at+3*m,youtubeAccount:'ytowner',minSessions:99};
  const p=s.analytics(options).timeline.find(x=>x.at===at+m)!;
  assert.equal(p.messages,12);assert.equal(p.twitchMessages,9);assert.equal(p.youtubeMessages,3);
  assert.equal(p.regularMessages,3);assert.equal(p.regularTwitchMessages,2);assert.equal(p.regularYoutubeMessages,1);
  assert.equal(p.followerMessages,4);assert.equal(p.followerTwitchMessages,3);assert.equal(p.followerYoutubeMessages,1);
  assert.equal(p.unknownMessages,1);assert.equal(p.unknownTwitchMessages,0);assert.equal(p.unknownYoutubeMessages,1);
  assert.equal(p.messages-p.regularMessages-p.followerMessages-p.unknownMessages,4);
  assert.equal(s.analytics({...options,source:'twitch'}).timeline.find(x=>x.at===at+m)!.messages,9);
  assert.equal(s.analytics({...options,source:'youtube'}).timeline.find(x=>x.at===at+m)!.messages,3);
 }finally{s.close();}
});
test('event source filter applies before the shared 200-row limit',()=>{
 const s=new StreamStore(':memory:');try{
  const sid=s.observePlatformStream('twitch','owner','one',at,at,null,'Stream')!;
  s.observePlatformStream('youtube','ytowner','video',at,at,null,'Stream');
  s.ingest({source:'twitch',accountId:'owner',externalId:'old',type:'chat.message',actor:{externalId:'old',displayName:'old'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'old Twitch'}});
  s.youtubeMessages('ytowner','chat',Array.from({length:205},(_,i)=>({id:`yt-${i}`,snippet:{type:'textMessageEvent',publishedAt:new Date(at+m+i).toISOString(),displayMessage:'YouTube'},authorDetails:{channelId:'yt',displayName:'yt'}})));
  assert.equal(s.events(sid).length,200);assert.ok(s.events(sid).every(e=>e.source==='youtube'));
  assert.equal(s.events(sid,undefined,undefined,undefined,undefined,'twitch').length,1);
  assert.ok(s.events(sid,undefined,undefined,undefined,'chat.message','youtube').every(e=>e.source==='youtube'));
  assert.equal(s.events(sid,undefined,undefined,undefined,'donation','youtube').length,0);
  assert.equal(s.events(sid,undefined,undefined,undefined,undefined,'donationalerts').length,0);
  assert.throws(()=>s.events(sid,undefined,undefined,undefined,undefined,'invalid'),/INVALID_EVENT_SOURCE/);
 }finally{s.close();}
});
