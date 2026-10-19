import test from 'node:test';
import assert from 'node:assert/strict';
import {startEventRetention} from '../src/event-retention.js';
import {invalidatesCachedReads,storeOperations} from '../src/store-contract.js';
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
test('retention waits for idle, performs one batch a minute and never invalidates analytical reads',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let pending=1,calls=0,enabled=false;
 const runtime={db:{queueStatus:()=>({pending}),call:async()=>{calls++;return 500;}}};
 const stop=startEventRetention(()=>[runtime] as any,()=>enabled,()=>assert.fail('unexpected error'));
 try{
  enabled=true;t.mock.timers.tick(60000);await settle();assert.equal(calls,0);
  pending=0;t.mock.timers.tick(60000);await settle();assert.equal(calls,1);
  t.mock.timers.tick(59999);await settle();assert.equal(calls,1);t.mock.timers.tick(1);await settle();assert.equal(calls,2);
  assert.equal(storeOperations.recentEvents,'read');assert.equal(invalidatesCachedReads('purgeRecentEvents',[]),false);
  stop();t.mock.timers.tick(60000);await settle();assert.equal(calls,2);
 }finally{stop();t.mock.timers.reset();}
});
test('retention isolates errors, cannot overlap and stops in-flight without scheduling another profile',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let failures=0,calls=0,release!:(value:number)=>void;
 const broken={db:{call:async()=>{throw Error('unavailable');}}},active={db:{call:()=>{calls++;return new Promise<number>(resolve=>{release=resolve;});}}};
 const stop=startEventRetention(()=>[broken,active,active] as any,()=>true,()=>failures++);
 try{
  await settle();assert.equal(failures,1);assert.equal(calls,1);
  t.mock.timers.tick(120000);await settle();assert.equal(calls,1);
  stop();release(500);await settle();t.mock.timers.tick(60000);await settle();assert.equal(calls,1);
 }finally{stop();t.mock.timers.reset();}
});
