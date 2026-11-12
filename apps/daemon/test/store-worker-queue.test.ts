import test from 'node:test';
import assert from 'node:assert/strict';
import {nextStoreRequest} from '../src/store-worker-queue.js';
test('foreground reads/writes pass warm work while preserving order and client lifetime barriers',()=>{
 const queue=[{method:'warmAnalytics'},{method:'advanceAnalytics'},{method:'ingest'},{method:'analytics'},{method:'close'},{method:'changes'}];
 assert.equal(nextStoreRequest(queue).method,'ingest');assert.equal(nextStoreRequest(queue).method,'analytics');
 assert.equal(nextStoreRequest(queue).method,'warmAnalytics');assert.equal(nextStoreRequest(queue).method,'advanceAnalytics');
 assert.equal(nextStoreRequest(queue).method,'close');assert.equal(nextStoreRequest(queue).method,'changes');
 const opening=[{method:'',open:true},{method:'analytics'}];assert.equal(nextStoreRequest(opening).open,true);
});
