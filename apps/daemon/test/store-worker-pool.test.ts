import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {StoreClient} from '../src/db.js';
test('one SQLite worker isolates profile RPC replies and closing one client leaves its peer collecting',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-worker-pool-')),path=join(dir,'data.sqlite'),a=new StoreClient(path,'ruslan'),b=new StoreClient(path,'gulnaz');let reopened:StoreClient|undefined;
 try{await Promise.all([a.ready,b.ready]);assert.equal((a as any).worker,(b as any).worker);
 const ids=await Promise.all([a.call('createPerson','Ruslan viewer'),b.call('createPerson','Gulnaz viewer')]);assert.notEqual((ids[0] as any).id,(ids[1] as any).id);
 const [peopleA,peopleB]=await Promise.all([(a.call('persons') as Promise<any[]>),(b.call('persons') as Promise<any[]>)]);assert.deepEqual(peopleA.map(p=>p.display_name),['Ruslan viewer']);assert.deepEqual(peopleB.map(p=>p.display_name),['Gulnaz viewer']);
 await Promise.all([a.stop(),a.stop()]);await assert.rejects(a.call('persons'),/DB_WORKER_STOPPED/);assert.equal((await (b.call('persons') as Promise<any[]>)).length,1);
 reopened=new StoreClient(path,'ruslan');await reopened.ready;assert.equal((reopened as any).worker,(b as any).worker);assert.deepEqual((await (reopened.call('persons') as Promise<any[]>)).map(p=>p.display_name),['Ruslan viewer']);
 const invalid=new StoreClient(path,'INVALID');await assert.rejects(invalid.ready,/INVALID_PROFILE/);await assert.rejects(invalid.stop(),/INVALID_PROFILE/);assert.equal((await (b.call('persons') as Promise<any[]>)).length,1);
 await b.stop();assert.equal((await (reopened.call('persons') as Promise<any[]>)).length,1);
 }finally{await Promise.all([a.stop(),b.stop(),reopened?.stop()]);await rm(dir,{recursive:true,force:true});}
});
test('independent in-memory clients never share their database or lifecycle',async()=>{
 const a=new StoreClient(':memory:'),b=new StoreClient(':memory:');try{await Promise.all([a.ready,b.ready]);await a.call('createPerson','Only A');assert.deepEqual(await b.call('persons'),[]);await a.stop();assert.deepEqual(await b.call('persons'),[]);}finally{await Promise.all([a.stop(),b.stop()]);}
});

test('a shared worker crash fails both clients once and a replacement reads their committed profile facts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-worker-recover-')),path=join(dir,'data.sqlite'),a=new StoreClient(path,'ruslan'),b=new StoreClient(path,'gulnaz');let next:StoreClient|undefined;
 try{await Promise.all([a.ready,b.ready]);await a.call('createPerson','Preserved');let failures=0;a.setFatalHandler(()=>failures++);b.setFatalHandler(()=>failures++);
 await (a as any).worker.terminate();assert.equal(failures,2);await assert.rejects(a.call('summary'),/DB_WORKER_STOPPED/);await assert.rejects(b.call('summary'),/DB_WORKER_STOPPED/);
 next=new StoreClient(path,'ruslan');await next.ready;assert.deepEqual((await (next.call('persons') as Promise<any[]>)).map(p=>p.display_name),['Preserved']);
 }finally{await Promise.all([a.stop(),b.stop(),next?.stop()]);await rm(dir,{recursive:true,force:true});}
});

test('writes through another client invalidate long-lived analytics without crossing profile boundaries',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-worker-cache-')),path=join(dir,'data.sqlite'),a=new StoreClient(path,'ruslan'),b=new StoreClient(path,'ruslan'),other=new StoreClient(path,'gulnaz');
 try{
  await Promise.all([a.ready,b.ready,other.ready]);const at=Date.UTC(2026,9,1),sid=String(await a.call('startSession','owner','shared-cache',at,'platform',at));await a.call('streamSample',sid,at,'game','Game','',3);await a.call('endSession',sid,at+60000);
  const query={fromMs:at,toMs:at+120000};assert.equal((await a.call('analytics',query)).streamComparison[0]!.viewers.twitch.mean,3);
  const calls=a.queueStatus().operations.analytics!.calls;assert.equal((await a.call('analytics',query)).summary.streams,1);assert.equal(a.queueStatus().operations.analytics!.calls,calls);
  await other.call('analytics',query);const unrelatedCalls=other.queueStatus().operations.analytics!.calls;
  await b.call('streamSample',sid,at,'game','Game','',9);assert.equal((await a.call('analytics',query)).streamComparison[0]!.viewers.twitch.mean,9);
  assert.equal((await other.call('analytics',query)).summary.streams,0);assert.equal(other.queueStatus().operations.analytics!.calls,unrelatedCalls,'writes never evict another profile cache');
 }finally{await Promise.all([a.stop(),b.stop(),other.stop()]);await rm(dir,{recursive:true,force:true});}
});

test('a failed analytics worker recovers once for concurrent readers while collection stays available',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-analytics-recovery-')),path=join(dir,'data.sqlite'),client=new StoreClient(path,'ruslan');
 try{
  await client.ready;const at=Date.now()-60000,id=String(await client.call('startSession','owner','recovery',at,'platform',at));await client.call('streamSample',id,at,'game','Game','',3);await client.call('endSession',id,at+30000);
  const q={sessionId:id,fromMs:0,toMs:Date.now()};assert.equal((await client.call('analytics',q)).summary.streams,1);
  const collection=(client as any).worker,old=(client as any).analyticsClient.worker;assert.notEqual(collection,old);await old.terminate();
  assert.equal((await client.call('changes')).stream,null);
  const [a,b]=await Promise.all([client.call('analytics',q),client.call('analytics',q)]);assert.equal(a.summary.streams,1);assert.equal(b.summary.streams,1);assert.notEqual((client as any).analyticsClient.worker,old);assert.equal((client as any).worker,collection);
 }finally{await client.stop();await rm(dir,{recursive:true,force:true});}
});

test('a merge in one profile reaches cached reads of the other profile at once and settles without repeated work',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-worker-shared-')),path=join(dir,'data.sqlite'),a=new StoreClient(path,'ruslan'),b=new StoreClient(path,'gulnaz');
 try{
  await Promise.all([a.ready,b.ready]);const at=Date.UTC(2026,9,29,12);
  const chat=(user:string,name:string)=>({source:'twitch' as const,accountId:'owner',externalId:`${user}-chat`,type:'chat.message',actor:{externalId:user,displayName:name},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider' as const,transport:'eventsub' as const,payload:{text:'hi'}});
  const video=[{id:'yt-chat',snippet:{type:'textMessageEvent',publishedAt:new Date(at).toISOString(),displayMessage:'hi'},authorDetails:{channelId:'UCegor',displayName:'@egorbarinov'}}];
  for(const client of [a,b]){await client.call('ingest',chat('100','chikist007'));await client.call('youtubeMessages','yt','chat',video);}
  assert.equal((await (b.call('persons') as Promise<any[]>)).length,2);
  const people=await (a.call('persons') as Promise<any[]>),tw=people.find(p=>p.display_name==='chikist007'),yt=people.find(p=>p.display_name==='@egorbarinov');
  await a.call('merge',yt.id,tw.id,yt.revision,tw.revision,at);
  assert.deepEqual((await (b.call('persons') as Promise<any[]>)).map(p=>p.display_name),['chikist007'],'the other profile observes the shared merge before its next cache hit');
  const calls=b.queueStatus().operations.persons!.calls;
  for(let i=0;i<3;i++){await b.call('persons');await a.call('changes');}
  assert.equal(b.queueStatus().operations.persons!.calls,calls,'nothing keeps invalidating after the change settled');
 }finally{await Promise.all([a.stop(),b.stop()]);await rm(dir,{recursive:true,force:true});}
});
