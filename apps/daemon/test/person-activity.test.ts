import test from 'node:test';import assert from 'node:assert/strict';import {StoreClient} from '../src/db.js';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
test('person activity stays isolated, deduplicates overlapping observations and tracks channel reward updates',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-person-activity-'));const db=new StoreClient(join(dir,'db.sqlite'));const at=Date.UTC(2026,9,11,12);
 try{
  const sid=await db.call<string>('observePlatformStream','twitch','owner','stream',at,at,null,'Stream');
  const person=await db.call<any>('ingest',{source:'twitch',accountId:'owner',externalId:'message',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}});
  for(let i=0;i<2;i++)await db.call('recordPoll',sid,'owner',{startedAtMs:at,completedAtMs:at+60000,status:'complete',userIds:['viewer']});
  for(const [externalId,status] of [['redeem','UNFULFILLED'],['updated','FULFILLED']])await db.call('ingest',{source:'twitch',accountId:'owner',externalId,type:'channel_points_custom_reward_redemption.add',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:at+(externalId==='updated'?1000:0),receivedAtMs:at+1000,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{reward:{title:'Sound',cost:100},raw:{payload:{event:{id:'redemption-id',status}}}}});
  await db.call('endSession',sid,at+3*60000);
  const result=await db.call<any>('personActivity',person.personId);assert.equal(result.visits.length,1);assert.equal(result.visits[0].minutes,2);assert.equal(result.hours[15].minutes,2);assert.equal(result.rewards.length,1);assert.equal(result.rewards[0].status,'FULFILLED');assert.equal(result.balance,null);
  await assert.rejects(db.call('personActivity','missing'),/PERSON_NOT_FOUND/);
 }finally{await db.stop();await rm(dir,{recursive:true,force:true});}
});
