import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const minute=60000,at=Date.UTC(2026,9,31,12);
const message=(id:string,user:string,time:number)=>({id,snippet:{type:'textMessageEvent',publishedAt:new Date(time).toISOString()},authorDetails:{channelId:user,displayName:user}});
function chat(s:StreamStore,id:string,user:string,time:number,name=user){s.ingest({source:'twitch',accountId:'owner',externalId:id,type:'chat.message',actor:{externalId:user,displayName:name},occurredAtMs:time,receivedAtMs:time,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{}});}
test('current chat includes silent Twitch members, excludes renamed owner/bots and counts current-stream messages without inventing YouTube presence',()=>{
 const s=new StreamStore(':memory:');try{
  const sid=s.observePlatformStream('twitch','owner','live',at,at,null,'live')!;
  s.observePlatformStream('youtube','yt-owner','yt-live',at,at,null,'live');
  s.ensureOwnerIdentity('owner','owner','Fullrandomname_twitch',at);
  s.ensureOwnerIdentity('owner','owner','rlod',at+minute);
  const poll=(from:number,to:number,users:string[])=>s.recordPoll(sid,'owner',{startedAtMs:from,completedAtMs:to,status:'complete',userIds:users,userNames:{owner:'rlod',silent:'Silent',talker:'Talker',streamelements:'StreamElements'}});
  poll(at,at+minute,['owner','silent','talker','streamelements']);poll(at+minute,at+2*minute,['silent','talker','owner','streamelements']);
  chat(s,'one','talker',at+minute);chat(s,'two','talker',at+2*minute);
  s.youtubeMessages('yt-owner','chat',[message('yt1','youtube-user',at+minute),message('yt2','youtube-user',at+2*minute)]);
  const result=s.currentChat(sid,[],false,at+2*minute+1000);
  assert.equal(result.twitchState,'current');
  assert.deepEqual(result.people.filter(p=>p.source==='twitch').map(p=>p.name).sort(),['Silent','talker']);
  const silent=result.people.find(p=>p.name==='Silent')!;assert.equal(silent.messages,0);assert.equal(silent.lastMessageAt,null);assert.equal(silent.minutes,3,'overlapping inclusive minute buckets count once');
  const talker=result.people.find(p=>p.name==='talker'||p.name==='Talker')!;assert.equal(talker.messages,2);assert.equal(talker.lastMessageAt,at+2*minute);
  const yt=result.people.find(p=>p.source==='youtube')!;assert.equal(yt.minutes,null);assert.equal(yt.messages,2);
  assert.ok(s.currentChat(sid,[],true,at+2*minute+1000).people.some(p=>p.name==='rlod'));
  s.recordPoll(sid,'owner',{startedAtMs:at+2*minute,completedAtMs:at+3*minute,status:'partial',userIds:['talker']});
  const partial=s.currentChat(sid,[],false,at+3*minute+1000);assert.equal(partial.twitchState,'stale');assert.ok(partial.people.some(p=>p.name==='Silent'),'partial snapshots do not evict silent members');
  assert.equal(s.currentChat(sid,[],false,at+12*minute).people.some(p=>p.source==='youtube'),false,'YouTube expires at exactly ten minutes without evidence of leaving');
  poll(at+12*minute,at+13*minute,[]);assert.equal(s.currentChat(sid,[],false,at+13*minute).people.length,0,'a complete empty snapshot replaces the old list');
  s.endSession(sid,at+14*minute);assert.equal(s.currentChat(sid,[],false,at+14*minute).live,false);
 }finally{s.close();}
});
test('new broadcasts and profiles never reuse an old participant snapshot',()=>{
 const s=new StreamStore(':memory:','ruslan');try{
  const first=s.observePlatformStream('twitch','owner','old',at,at,null,'old')!;
  s.recordPoll(first,'owner',{startedAtMs:at,completedAtMs:at+minute,status:'complete',userIds:['silent']});s.endSession(first,at+2*minute);
  const next=s.observePlatformStream('twitch','owner','new',at+3*minute,at+3*minute,null,'new')!;
  const result=s.currentChat(next,[],false,at+4*minute);assert.equal(result.twitchState,'waiting');assert.deepEqual(result.people,[]);
  assert.equal(result.observedAt,null,'a resumed logical stream still needs its own new Twitch snapshot');
 }finally{s.close();}
});
test('current chat remains isolated in two profiles sharing a file, including owner visibility',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-current-chat-')),path=join(dir,'data.db');
 const ruslan=new StreamStore(path,'ruslan'),gulnaz=new StreamStore(path,'gulnaz');
 try{
  for(const [store,owner,guest] of [[ruslan,'ruslan-id','gulnaz-id'],[gulnaz,'gulnaz-id','ruslan-id']] as const){
   const sid=store.observePlatformStream('twitch',owner,'live',at,at,null,'live')!;
   store.ensureOwnerIdentity(owner,owner,owner==='ruslan-id'?'rlod':'AmaliaMelina',at);
   store.recordPoll(sid,owner,{startedAtMs:at,completedAtMs:at+minute,status:'complete',userIds:[owner,guest],userNames:{'ruslan-id':'rlod','gulnaz-id':'AmaliaMelina'}});
   const rows=store.currentChat(sid,[],false,at+minute).people;
   assert.equal(rows.length,1);assert.equal(rows[0]!.name,guest==='ruslan-id'?'rlod':'AmaliaMelina');
   const other=store===ruslan?gulnaz:ruslan;
   assert.equal(other.currentChat(sid,[],true,at+minute).people.length,0,'the other profile cannot read this stream even with exclusions disabled');
  }
 }finally{ruslan.close();gulnaz.close();rmSync(dir,{recursive:true,force:true});}
});
