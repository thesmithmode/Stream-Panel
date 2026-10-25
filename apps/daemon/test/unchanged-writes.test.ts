import test from 'node:test';import assert from 'node:assert/strict';import {StoreClient} from '../src/db.js';
test('an unchanged follower check retains cached reads; real profile facts invalidate them',async()=>{
 const db=new StoreClient(':memory:');try{
  await db.call('followingSnapshot','twitch','owner',[],true,1000,null);await db.call('persons');const first=db.queueStatus().operations.persons!.calls;
  await db.call('followingSnapshot','twitch','owner',[],true,2000,null);await db.call('persons');assert.equal(db.queueStatus().operations.persons!.calls,first);
  await db.call('createPerson','New person');await db.call('persons');assert.equal(db.queueStatus().operations.persons!.calls,first+1);
 }finally{await db.stop();}
});

test('version checks invalidate stale reads after a separate connection repairs facts',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{StreamStore}=await import('../../../packages/core/src/store.js');
 const dir=await mkdtemp(join(tmpdir(),'external-repair-')),path=join(dir,'data.sqlite'),db=new StoreClient(path,'ruslan');
 try{
  await db.call('changes');assert.deepEqual(await db.call('persons'),[]);const before=db.queueStatus().operations.persons!.calls;
  const other=new StreamStore(path,'ruslan');try{other.createPerson('Repaired person');}finally{other.close();}
  await db.call('changes');assert.equal((await db.call('persons')).length,1);assert.equal(db.queueStatus().operations.persons!.calls,before+1);
  await db.call('changes');await db.call('persons');assert.equal(db.queueStatus().operations.persons!.calls,before+1,'unchanged metadata must retain the repaired snapshot');
 }finally{await db.stop();await rm(dir,{recursive:true,force:true});}
});
