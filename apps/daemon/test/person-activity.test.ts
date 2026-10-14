import test from 'node:test';import assert from 'node:assert/strict';import {StoreClient} from '../src/db.js';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
test('person activity stays isolated, deduplicates overlapping observations and retains raw reward events without computing unavailable balances',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-person-activity-'));const db=new StoreClient(join(dir,'db.sqlite'));const at=Date.UTC(2026,9,11,12);
 try{
  const sid=await db.call<string>('observePlatformStream','twitch','owner','stream',at,at,null,'Stream');
  const person=await db.call<any>('ingest',{source:'twitch',accountId:'owner',externalId:'message',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}});
  for(let i=0;i<2;i++)await db.call('recordPoll',sid,'owner',{startedAtMs:at,completedAtMs:at+60000,status:'complete',userIds:['viewer']});
  for(const [externalId,status] of [['redeem','UNFULFILLED'],['updated','FULFILLED']] as const)await db.call('ingest',{source:'twitch',accountId:'owner',externalId,type:'channel_points_custom_reward_redemption.add',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:at+(externalId==='updated'?1000:0),receivedAtMs:at+1000,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{reward:{title:'Sound',cost:100},raw:{payload:{event:{id:'redemption-id',status}}}}});
  await db.call('endSession',sid,at+3*60000);
  const result=await db.call<any>('personActivity',person.personId);assert.equal(result.visits.length,1);assert.equal(result.visits[0].minutes,2);assert.equal(result.hours[15].minutes,2);assert.equal('rewards' in result,false);assert.equal('balance' in result,false);
  const yt=await db.call<string>('observePlatformStream','youtube','yt-owner','video',at,at,null,'YT');
  await db.call('youtubeMessages','yt-owner','chat',[{id:'yt-message',snippet:{type:'textMessageEvent',publishedAt:new Date(at).toISOString()},authorDetails:{channelId:'author',displayName:'YT viewer'}}]);
  await db.call('endSession',yt,at+3*60000);
  const activity=await db.call<any>('personActivity','youtube:author');assert.equal(activity.hasEstimatedActivity,true);assert.equal(activity.hours[15].minutes,3);assert.equal(activity.visits.length,1);assert.equal('rewards' in activity,false);
  const archived=await db.call<any[]>('events',sid,person.personId);assert.equal(archived.filter(e=>e.type.startsWith('channel_points')).length,2);
  await assert.rejects(db.call('personActivity','missing'),/PERSON_NOT_FOUND/);
 }finally{await db.stop();await rm(dir,{recursive:true,force:true});}
});
