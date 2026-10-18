import test from 'node:test';import assert from 'node:assert/strict';import {ClockVisitors} from './clock-visitors.ts';
const page={items:[{id:'one',name:'One',visits:1}],total:1,offset:0,limit:100};
test('preload shares concurrent requests, serves all half-hour clicks locally and retains exact pagination',async()=>{
 let calls=0;const cache=new ClockVisitors(async q=>{calls++;await Promise.resolve();return q.clockBatch?{clockPages:Array.from({length:48},(_,i)=>({minute:i*30,page}))}:{clockVisitors:{...page,offset:Number(q.clockOffset)}};});
 await Promise.all([cache.prefetch('all',30),cache.page('all',30,1110),cache.page('all',30,0)]);assert.equal(calls,1);
 for(let minute=0;minute<1440;minute+=30)assert.deepEqual(await cache.page('all',30,minute),page);
 assert.equal(calls,1);assert.equal((await cache.page('all',30,0,100)).offset,100);assert.equal(calls,2);
 await cache.prefetch('all',1);assert.equal(calls,2);cache.close();await assert.rejects(cache.page('all',30,0),/abort/i);
});
test('failed batches can retry, missing buckets are empty and close aborts in-flight work',async()=>{
 let fail=true;const cache=new ClockVisitors(async()=>{if(fail){fail=false;throw Error('offline');}return {};});
 await assert.rejects(cache.prefetch('all',30),/offline/);assert.equal((await cache.page('all',30,0)).total,0);cache.close();
 let started!:(signal:AbortSignal)=>void;const signal=new Promise<AbortSignal>(resolve=>{started=resolve;});
 const pending=new ClockVisitors(async(_,signal)=>{started(signal);return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason)));});
 const request=pending.page('all',30,0);await signal;pending.close();await assert.rejects(request);
});
