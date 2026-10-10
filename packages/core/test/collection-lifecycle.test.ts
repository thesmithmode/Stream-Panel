import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
test('collector stops and crashes create persistent gaps while heartbeats cannot rewrite history',()=>{
 const s=new StreamStore(':memory:');try{
  s.collectionLifecycle('start',100);assert.equal(s.gaps().length,0);
  s.collectionLifecycle('heartbeat',200);s.collectionLifecycle('stop',300);
  assert.equal(s.gaps()[0]!.ended_at_ms,null);
  s.collectionLifecycle('stop',350);assert.equal(s.gaps().length,1);
  s.collectionLifecycle('start',400);assert.equal(s.gaps()[0]!.ended_at_ms,400);
  s.collectionLifecycle('heartbeat',500);s.collectionLifecycle('start',700);
  assert.equal(s.gaps()[0]!.reason,'collector_restarted');assert.equal(s.gaps()[0]!.started_at_ms,500);assert.equal(s.gaps()[0]!.ended_at_ms,700);
  assert.throws(()=>s.collectionLifecycle('heartbeat',600),/STALE_COLLECTION_STATE/);
  assert.throws(()=>s.collectionLifecycle('bad' as any,800),/INVALID_COLLECTION_ACTION/);
 }finally{s.close();}
});
