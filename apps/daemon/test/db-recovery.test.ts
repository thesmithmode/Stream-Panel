import test from 'node:test';import assert from 'node:assert/strict';
import {StoreClient} from '../src/db.js';
test('an unexpected worker exit invalidates reads and invokes recovery once; intentional stop does not',async()=>{
 const db=new StoreClient(':memory:');await db.ready;let calls=0;db.setFatalHandler(error=>{assert.equal(error.message,'DB_WORKER_STOPPED');calls++;});
 await db.call('summary');await (db as any).worker.terminate();assert.equal(calls,1);await assert.rejects(db.call('summary'),/DB_WORKER_STOPPED/);
 let late=0;db.setFatalHandler(()=>late++);assert.equal(late,1);await db.stop();assert.equal(calls,1);
 const normal=new StoreClient(':memory:');await normal.ready;normal.setFatalHandler(()=>{throw Error('normal stop must not trigger recovery');});await normal.stop();
});
