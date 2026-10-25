import test from 'node:test';import assert from 'node:assert/strict';import {StoreClient} from '../src/db.js';
test('an unchanged follower check retains cached reads; real profile facts invalidate them',async()=>{
 const db=new StoreClient(':memory:');try{
  await db.call('followingSnapshot','twitch','owner',[],true,1000,null);await db.call('persons');const first=db.queueStatus().operations.persons!.calls;
  await db.call('followingSnapshot','twitch','owner',[],true,2000,null);await db.call('persons');assert.equal(db.queueStatus().operations.persons!.calls,first);
  await db.call('createPerson','New person');await db.call('persons');assert.equal(db.queueStatus().operations.persons!.calls,first+1);
 }finally{await db.stop();}
});
