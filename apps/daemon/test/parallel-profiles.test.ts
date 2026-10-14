import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import Database from 'better-sqlite3';import {StoreClient} from '../src/db.js';
test('parallel profile workers retain separate live events, samples, donors and notes in one growing database',{timeout:30000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-parallel-')),path=join(dir,'data.sqlite'),clients=[new StoreClient(path,'ruslan'),new StoreClient(path,'gulnaz')];
 try{
  await Promise.all(clients.map(c=>c.ready));const start=Date.now()-120000;
  const ids=await Promise.all(clients.map(c=>c.call<string>('observePlatformStream','twitch','owner','same-stream',start,start,null,'Live')));
  assert.notEqual(ids[0],ids[1]);
  await Promise.all(clients.map(async(c,index)=>{
   for(let n=0;n<150;n++){
    await c.call('ingest',{source:'twitch',accountId:'owner',externalId:String(n),type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:start+n*100,receivedAtMs:start+n*100,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:`Profile ${index}`}});
    if(n%25===0){await c.call('streamSample',ids[index]!,start+n*100,'g','Game','Live',index+1);await c.call('recordPoll',ids[index]!,'owner',{startedAtMs:start,completedAtMs:start+n*100,status:'complete',userIds:['viewer']});}
   }
   const people=await c.call<{id:string}[]>('persons');const person=people.find(p=>p.id)!;
   for(let n=0;n<30;n++){const note=await c.call<{id:string;revision:number}>('createPersonNote',person.id,`Note ${index} ${n}`);await c.call('updatePersonNote',person.id,note.id,`Updated ${index}`,note.revision);if(n%2===0)await c.call('deletePersonNote',person.id,note.id,1);}
   await c.call('ingest',{source:'donationalerts',accountId:'da',externalId:'same-tip',type:'donation',actor:null,occurredAtMs:start,receivedAtMs:start,sourceTime:null,timeQuality:'provider',transport:'rest',payload:{amountMinor:String((index+1)*10000),currency:'RUB'}});
  }));
  for(const [index,c] of clients.entries()){
   const summary=await c.call<any>('summary',ids[index]!,[],false);assert.equal(summary.messages,150);assert.equal(summary.totals.RUB,String((index+1)*10000));
   const sessions=await c.call<any[]>('sessions',ids[index]);assert.equal(sessions.length,1);assert.equal(sessions[0].viewerPeak,index+1);assert.deepEqual(await c.call('sessions',ids[1-index]),[]);
   const events=await c.call<any[]>('events',ids[index]);assert.ok(events.filter(e=>e.type==='chat.message').every(e=>e.payload.text===undefined&&e.payload.count===1));
  }
  const probe=new Database(path);try{assert.equal(probe.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(probe.pragma('foreign_key_check'),[]);}finally{probe.close();}
 }finally{await Promise.all(clients.map(c=>c.stop()));await rm(dir,{recursive:true,force:true});}
});
test('a worker that exits before readiness rejects instead of leaving calls waiting forever',async()=>{
 const db=new StoreClient(':memory:');const internals=db as unknown as {worker:{terminate:()=>Promise<number>}};const rejected=assert.rejects(db.ready,/DB_WORKER_STOPPED/);await internals.worker.terminate();await rejected;await assert.rejects(db.call('sessions'),/DB_WORKER_STOPPED/);await db.stop();
});
