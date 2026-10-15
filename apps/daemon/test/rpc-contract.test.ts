import test from 'node:test';
import assert from 'node:assert/strict';
import {StoreClient} from '../src/db.js';

test('RPC derives the result from the operation and records queue/worker timings',async()=>{
 const db=new StoreClient(':memory:');
 try{
  await db.ready;
  const people=await db.call('persons');
  assert.deepEqual(people,[]);
  const status=db.queueStatus();assert.equal(status.pending,0);assert.equal(status.operations.persons?.calls,1);assert.ok(status.operations.persons!.maxExecutionMs>=0);assert.ok(status.operations.persons!.maxQueueMs>=0);
  // Compile-only contracts: assertions cannot substitute a made-up response type.
  if(false){
   // @ts-expect-error persons returns an array, never a number.
   const count:number=await db.call('persons');void count;
   // @ts-expect-error the generic parameter is a request tuple, not a response type.
   await db.call<number>('persons');
  }
 }finally{await db.stop();}
});

test('a nonresponsive SQLite worker is stopped and all callers reject through recovery',async()=>{
 const db=new StoreClient(':memory:',undefined,25);await db.ready;
 let failures=0;db.setFatalHandler(()=>failures++);
 const worker=(db as any).worker,post=worker.postMessage;
 worker.postMessage=()=>{};
 try{
  const pending=db.call('persons');
  await assert.rejects(pending,/DB_WORKER_STOPPED/);
  assert.equal(failures,1);
  await assert.rejects(db.call('summary'),/DB_WORKER_STOPPED/);
 }finally{worker.postMessage=post;await db.stop();}
});
