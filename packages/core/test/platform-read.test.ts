import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';

test('platform stream readers return empty state, closed links, and latest open platform session',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-platform-read-'));
 const store=new StreamStore(join(dir,'data.sqlite'));
 try {
  assert.deepEqual(store.platformStreams('missing'),[]);
  assert.equal(store.activeLogicalStream(),null);
  const closedId=store.startSession('twitch-account','old-stream',1000,'platform',1100);
  const manualId=store.startSession('manual-account','manual-stream',1500,'manual',1600);
  assert.equal((store.activeLogicalStream() as {id:string}).id,closedId);
  assert.equal(store.platformStreams(closedId)[0]!.ended_at_ms,null);
  store.endSession(closedId,2000);
  assert.equal(store.activeLogicalStream(),null);
  assert.equal(store.platformStreams(closedId)[0]!.ended_at_ms,2000);
  const activeId=store.startSession('twitch-account','new-stream',2500,'platform',2600);
  assert.equal((store.activeLogicalStream() as {id:string}).id,activeId);
  assert.equal(store.platformStreams(activeId)[0]!.ended_at_ms,null);
  assert.equal((store.sessions().find(row=>row.id===manualId) as {kind:string}).kind,'manual');
  store.endSession(activeId,3000);
  assert.equal(store.activeLogicalStream(),null);
 } finally {store.close();await rm(dir,{recursive:true,force:true});}
});

test('platform stream read methods are isolated by profile',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-platform-read-profiles-'));
 const path=join(dir,'data.sqlite');
 const stores=['ruslan','gulnaz'].map(profile=>new StreamStore(path,profile));
 try {
  const ids=stores.map((store,index)=>store.startSession('account',`stream-${index}`,1000,'platform',1100));
  assert.equal((stores[0]!.activeLogicalStream() as {id:string}).id,ids[0]);
  assert.equal((stores[1]!.activeLogicalStream() as {id:string}).id,ids[1]);
  assert.equal(stores[0]!.platformStreams(ids[1]!).length,0);
  assert.equal(stores[1]!.platformStreams(ids[0]!).length,0);
 } finally {for(const store of stores)store.close();await rm(dir,{recursive:true,force:true});}
});
