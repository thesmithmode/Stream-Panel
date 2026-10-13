import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';

test('people rolling periods filter events, donations, YouTube and presence across streams',()=>{
 const store=new StreamStore(':memory:');
 try {
  const now=Date.now(),day=86400000,from=now-7*day;
  const message=(id:string,name:string,at:number)=>store.ingest({source:'twitch',accountId:'owner',externalId:id,type:'chat.message',actor:{externalId:name,displayName:name},occurredAtMs:at,receivedAtMs:now,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}}).personId!;
  const old=message('old','Old',now-40*day),recent=message('new','Recent',now-day);
  message('earlier','Recent',now-10*day);
  for(const at of [now-day,now-10*day])store.createDonation({personId:recent,amount:'12.34',currency:'RUB',occurredAtMs:at,message:'',sourceName:'Manual'},now);
  store.youtubeMessages('yt','chat',[{id:'yt-old',snippet:{type:'textMessageEvent',publishedAt:new Date(now-10*day).toISOString()},authorDetails:{channelId:'viewer',displayName:'YT'}},{id:'yt-new',snippet:{type:'textMessageEvent',publishedAt:new Date(now-day).toISOString()},authorDetails:{channelId:'viewer',displayName:'YT'}}]);
  const youtube=store.persons().find(p=>p.display_name==='YT')!;
  const stream=store.startSession('owner','boundary',from-60000,'platform',from-60000);
  store.recordPoll(stream,'owner',{startedAtMs:from-60000,completedAtMs:from+60000,status:'complete',userIds:['Recent']});
  store.endSession(stream,from+60000);
  assert.equal(store.persons('',[],from).some(p=>p.id===old),false);
  assert.equal(store.persons('',[],now-30*day).some(p=>p.id===recent),true);
  const stats=store.personStats(recent,undefined,[],5,from);
  assert.equal(stats.messageCount,1);assert.deepEqual(stats.donationTotals,{RUB:'1234'});assert.equal(stats.totalObservedMinutes,1);
  assert.equal(store.personStats(String(youtube.id),undefined,[],5,from).messageCount,1);
  assert.equal(store.personStats(recent).messageCount,2);assert.deepEqual(store.personStats(recent).donationTotals,{RUB:'2468'});
  assert.equal(store.personsTop('messages',undefined,[],50,from).find(p=>p.id===recent)?.messageCount,1);
  assert.equal(store.personsTop('donations',undefined,[],50,from).find(p=>p.id===recent)?.donationCount,1);
  assert.equal(store.personsTop('observed_minutes',undefined,[],50,from).find(p=>p.id===recent)?.observedMinutes,1);
  assert.throws(()=>store.persons('',[],NaN),/INVALID_PERIOD/);
 } finally {store.close();}
});
