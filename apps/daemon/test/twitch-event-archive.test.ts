import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTwitch} from '../src/twitch.js';
import {StreamStore} from '../../../packages/core/src/store.js';
import {extraTwitchEvents} from './ignored-twitch-events.js';
test('supplementary Twitch notifications are discarded before storage or identity creation',()=>{
 const s=new StreamStore(':memory:');try{
 for(const [type,version] of extraTwitchEvents){
  const raw={metadata:{message_type:'notification',message_id:type,message_timestamp:'2026-10-10T10:00:00Z'},payload:{subscription:{type,version},event:{user_id:'bot',user_name:'Bot'}}};
  assert.equal(normalizeTwitch(raw,'owner'),null);
  assert.deepEqual(s.ingest({source:'twitch',accountId:'owner',externalId:type,type:type.replace(/^channel\./,''),actor:{externalId:'bot',displayName:'Bot'},occurredAtMs:1,receivedAtMs:1,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{raw}}),{inserted:false,identityId:null,personId:null});
 }
 assert.deepEqual(s.events(),[]);
 }finally{s.close();}
});
test('lifecycle notifications still normalize for reconciliation but do not create duplicate archive rows',()=>{
 const s=new StreamStore(':memory:');try{for(const type of ['stream.online','stream.offline']){
 const event=normalizeTwitch({metadata:{message_type:'notification',message_id:type,message_timestamp:'2026-10-10T10:00:00Z'},payload:{subscription:{type},event:{}}},'owner');
 assert.equal(event?.type,type);assert.equal(s.ingest(event!).inserted,false);
 }assert.deepEqual(s.events(),[]);}finally{s.close();}
});
