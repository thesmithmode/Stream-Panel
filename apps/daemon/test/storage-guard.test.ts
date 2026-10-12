import test from 'node:test';import assert from 'node:assert/strict';import {StorageGuard,STORAGE_RESERVE_BYTES} from '../src/storage-guard.js';
test('disk checks coalesce, preserve a reserve and recover without touching another application',async()=>{
 let free=STORAGE_RESERVE_BYTES+1,now=10000,reads=0;const guard=new StorageGuard('/fixture/data.sqlite',async()=>{reads++;return free;},()=>now);
 assert.equal(guard.status().freeBytes,null);await Promise.all([guard.check(),guard.check()]);assert.equal(reads,1);await guard.check();assert.equal(reads,1);
 free=STORAGE_RESERVE_BYTES-1;now+=5000;await assert.rejects(guard.check(),/STORAGE_RESERVE_LOW/);assert.equal(guard.status().freeBytes,free);await assert.rejects(guard.check(),/STORAGE_RESERVE_LOW/);assert.equal(reads,2);
 free=STORAGE_RESERVE_BYTES;now+=5000;await guard.check();const memory=new StorageGuard(':memory:',async()=>{throw Error('unexpected');});await memory.check();
 const failing=new StorageGuard('/fixture/data.sqlite',async()=>{throw Error('offline');});await assert.rejects(failing.check(),/offline/);
});
