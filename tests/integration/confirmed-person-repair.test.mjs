import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {StreamStore} from '../../dist/packages/core/src/store.js';import {daDonorExternalId} from '../../dist/packages/core/src/domain.js';
test('the deployment repair runs once and future deployments respect an explicit undo',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-person-repair-')),file=join(dir,'data.sqlite');
 const run=async()=>JSON.parse((await promisify(execFile)(process.execPath,[resolve('scripts/repair-confirmed-person.mjs')],{env:{...process.env,STREAM_PANEL_DATA_DIR:dir}})).stdout).confirmedPersonRepair;
 try{
  let s=new StreamStore(file,'ruslan');try{for(const [source,name] of [['twitch','chikist007'],['donationalerts','Egor4ik']])s.ingest({source,accountId:'owner',externalId:name,type:source==='twitch'?'chat.message':'donation',actor:{externalId:source==='twitch'?'123':daDonorExternalId(name),displayName:name},occurredAtMs:1000,receivedAtMs:1000,sourceTime:null,timeQuality:'provider',transport:'rest',payload:source==='twitch'?{text:'hello'}:{currency:'RUB',amountMinor:'100'}});}finally{s.close();}
  const first=await run();assert.equal(first.state,'merged');assert.equal((await stat(join(dir,'confirmed-person-repair-v1.json'))).mode&0o777,0o600);
  s=new StreamStore(file,'ruslan');try{s.undoMerge(first.mergeId,Date.now());assert.equal(s.persons().length,2);}finally{s.close();}
  assert.equal((await run()).state,'already-applied');s=new StreamStore(file,'ruslan');try{assert.equal(s.persons().length,2);}finally{s.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
