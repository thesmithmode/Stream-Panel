import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamStore } from '../src/store.js';

test('person lifetime includes older streams, averages only visits, and distinguishes follow from first observation', () => {
 const store=new StreamStore(':memory:');const base=Date.UTC(2026,0,1),minute=60000;
 try {
  const event=(id:string,type:string,at:number)=>({source:'twitch' as const,accountId:'channel',externalId:id,type,actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider' as const,transport:'eventsub' as const,payload:{text:'hello'}});
  const person=store.ingest(event('message','chat.message',base+minute)).personId!;
  for(let n=0;n<52;n++) {
   const start=base+n*86400000,id=store.startSession('channel',String(n),start,'platform',start);
   store.recordPoll(id,'channel',{startedAtMs:start,completedAtMs:start+10*minute,status:'complete',userIds:n===0||n===51?['viewer']:[]});
   store.endSession(id,start+10*minute);
  }
  store.ingest(event('follow','follow',base+15*minute));
  const stats:any=store.personStats(person);
  assert.equal(stats.totalObservedMinutes,20);
  assert.equal(stats.avgObservedMinutes,10);
  assert.equal(stats.sessionsWithObservation,2);
  assert.equal(stats.recordedStreams,52);
  assert.equal(stats.attendanceRatio,2/52);
  assert.equal(stats.followedAtMs,base+15*minute);
  assert.equal(stats.observedBeforeFollowMinutes,10);
  assert.equal(stats.firstObservedMs,base+10*minute);
 } finally {store.close();}
});
