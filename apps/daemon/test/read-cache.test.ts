import test from 'node:test';import assert from 'node:assert/strict';import {ReadCache} from '../src/read-cache.js';
test('cached reads deduplicate, clone results, and invalidate immediately after writes',async()=>{
 const cache=new ReadCache('');let count=0;
 const load=async()=>{count++;return {rows:[count]};};
 const [a,b]=await Promise.all([cache.read('ruslan',load),cache.read('ruslan',load)]);assert.equal(count,1);a.rows[0]=99;assert.equal(b.rows[0],1);
 assert.equal((await cache.read('ruslan',load)).rows[0],1);assert.equal((await cache.read('gulnaz',load)).rows[0],2);
 cache.invalidate();assert.equal((await cache.read('ruslan',load)).rows[0],3);cache.close();
});
test('a slow pre-mutation read cannot repopulate the cache or overwrite a new read',async()=>{
 const cache=new ReadCache('');let resolve!:(n:number)=>void;const old=cache.read('key',()=>new Promise<number>(r=>resolve=r));
 cache.invalidate();assert.equal(await cache.read('key',async()=>2),2);resolve(1);assert.equal(await old,1);assert.equal(await cache.read('key',async()=>3),2);cache.close();
});
test('failed reads are not cached; unavailable Redis falls back to SQLite',async()=>{
 const cache=new ReadCache('redis://127.0.0.1:1');await assert.rejects(cache.read('bad',async()=>{throw new Error('failure');}));assert.equal(await cache.read('bad',async()=>4),4);cache.close();
});
