import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
test('provider history appends snapshots while the current YouTube view advances and profiles remain isolated',()=>{
 const s=new StreamStore(':memory:','ruslan');try{
  s.youtubeSnapshot('channel','channel',{title:'First'},1);s.youtubeSnapshot('channel','channel',{title:'Second'},2);
  assert.equal((s.youtubeData('channel').snapshots.channel!.data as any).title,'Second');
  const raw=(s as any).db;
  assert.equal(raw.prepare('SELECT count(*) AS n FROM provider_snapshots').get().n,2);
  s.youtubeSnapshot('channel','cursor:chat','next',3);assert.equal(raw.prepare('SELECT count(*) AS n FROM provider_snapshots').get().n,2);
  assert.throws(()=>s.providerSnapshot('unknown','channel','stream',{},1),/INVALID_PROVIDER_SNAPSHOT/);
  const id=s.observePlatformStream('twitch','owner','one',10,10,null,'First')!;
  s.providerSnapshot('twitch','owner','stream',{custom:'full'},10,id);
  s.streamSample(id,10,'game','Game','First',1);s.streamSample(id,20,'other','Other','Second',2);
  assert.deepEqual(s.streamMetadata(id),[{at:10,categoryId:'game',categoryName:'Game',title:'First'},{at:20,categoryId:'other',categoryName:'Other',title:'Second'}]);
  assert.throws(()=>s.streamMetadata('missing'),/SESSION_NOT_FOUND/);
 }finally{s.close();}
});
