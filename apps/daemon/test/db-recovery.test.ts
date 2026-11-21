import test from 'node:test';import assert from 'node:assert/strict';
import {StoreClient} from '../src/db.js';
test('an unexpected worker exit invalidates reads and invokes recovery once; intentional stop does not',async()=>{
 const db=new StoreClient(':memory:');await db.ready;let calls=0;db.setFatalHandler(error=>{assert.equal(error.message,'DB_WORKER_STOPPED');calls++;});
 await db.call('summary');await (db as any).worker.terminate();assert.equal(calls,1);await assert.rejects(db.call('summary'),/DB_WORKER_STOPPED/);
 let late=0;db.setFatalHandler(()=>late++);assert.equal(late,1);await db.stop();assert.equal(calls,1);
 const normal=new StoreClient(':memory:');await normal.ready;normal.setFatalHandler(()=>{throw Error('normal stop must not trigger recovery');});await normal.stop();
});
import {EventEmitter} from 'node:events';
import type {Worker} from 'node:worker_threads';
// A single serial worker: each request reports pickup, then replies after `executionMs` (or never when stuck).
function fakeWorker(executionMs:(method:string)=>number|null){
 const worker=Object.assign(new EventEmitter(),{terminated:0,
  postMessage(message:{clientId:string;id:number;method:string}){queue.push(message);if(queue.length===1)next();},
  async terminate(){worker.terminated++;worker.emit('exit',1);return 1;}});
 const queue:{clientId:string;id:number;method:string}[]=[];
 const next=()=>{const message=queue[0];if(!message)return;worker.emit('message',{clientId:message.clientId,id:message.id,started:true,method:message.method});
  const ms=executionMs(message.method);if(ms===null)return;
  setTimeout(()=>{queue.shift();worker.emit('message',{clientId:message.clientId,id:message.id,result:message.method,executionMs:ms});next();},ms);};
 const acquire=(()=>{setImmediate(()=>worker.emit('message',{clientId:'fake',ready:true}));return {worker:worker as unknown as Worker,clientId:'fake',first:true,async release(){}};}) as unknown as ConstructorParameters<typeof StoreClient>[4];
 return {worker,acquire};
}
test('the request deadline counts execution only, so requests queued behind each other do not kill the worker',async()=>{
 const {worker,acquire}=fakeWorker(()=>60);
 const db=new StoreClient(':memory:',undefined,150,'facts',acquire);await db.ready;let fatal=0;db.setFatalHandler(()=>fatal++);
 // Six 60 ms requests: the last one waits ~300 ms in the queue, twice the 150 ms deadline.
 const results=await Promise.all(Array.from({length:6},()=>(db as any).call('streamSample')));
 assert.deepEqual(results,Array(6).fill('streamSample'));assert.equal(fatal,0);assert.equal(worker.terminated,0);
 assert.ok(db.queueStatus().operations.streamSample!.maxQueueMs>=150);
});
test('a request that runs past the deadline still fails the worker into recovery and rejects the queued requests',async()=>{
 const {worker,acquire}=fakeWorker(method=>method==='followingSnapshot'?null:10);
 const db=new StoreClient(':memory:',undefined,100,'facts',acquire);await db.ready;const errors:string[]=[];db.setFatalHandler(error=>errors.push(error.message));
 assert.equal(await (db as any).call('streamSample'),'streamSample');
 const stuck=(db as any).call('followingSnapshot'),queued=(db as any).call('streamSample');
 await assert.rejects(stuck,/DB_WORKER_STOPPED/);await assert.rejects(queued,/DB_WORKER_STOPPED/);
 assert.deepEqual(errors,['DB_WORKER_TIMEOUT']);assert.equal(worker.terminated,1);
});
test('requests queued behind a running database copy get the copy deadline, not the ordinary one',async()=>{
 const {worker,acquire}=fakeWorker(method=>method==='backup'?300:10);
 const db=new StoreClient(':memory:',undefined,100,'facts',acquire);await db.ready;let fatal=0;db.setFatalHandler(()=>fatal++);
 const [copy,queued]=await Promise.all([(db as any).call('backup'),(db as any).call('streamSample')]);
 assert.equal(copy,'backup');assert.equal(queued,'streamSample');assert.equal(fatal,0);assert.equal(worker.terminated,0);
});
