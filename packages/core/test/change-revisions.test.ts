import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {StreamStore} from '../src/store.js';import {daDonorExternalId} from '../src/domain.js';
test('profile versions persist; operational writes and identical payloads do not change report versions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-versions-')),file=join(dir,'db');let a=new StreamStore(file,'ruslan');const b=new StreamStore(file,'gulnaz');
 try{
  const initial=a.changes().versions,foreign=b.changes();
  a.collectionLifecycle('heartbeat',1000);a.youtubeSnapshot('yt','cursor:followers',true,1000);assert.deepEqual(a.changes().versions,initial);
  a.followingSnapshot('twitch','owner',[],true,2000,null);const followed=a.changes().versions.follows;
  a.followingSnapshot('twitch','owner',[],true,3000,null);assert.equal(a.changes().versions.follows,followed,'a new check of the same payload does not dirty analytics');
  const result=a.ingest({source:'donationalerts',accountId:'owner',externalId:'tip',type:'donation',actor:{externalId:daDonorExternalId('Supporter'),displayName:'Supporter'},occurredAtMs:4000,receivedAtMs:4000,sourceTime:null,timeQuality:'provider',transport:'rest',payload:{amountMinor:'100',currency:'RUB'}});
  assert.equal(a.changes().activeStream,null);assert.ok(a.changes().versions.donations!>initial.donations!,'offline donations must still invalidate their screens');
  assert.deepEqual(b.changes(),foreign,'another profile stays unchanged');
  const saved=a.changes().versions;a.close();a=new StreamStore(file,'ruslan');assert.deepEqual(a.changes().versions,saved);
  const person=result.personId!;const tip=a.createDonation({personId:person,amount:'1',currency:'RUB',occurredAtMs:5000,message:'',sourceName:'Cash'},5000);const revision=a.changes().versions.donations!;
  a.updateDonation(String(tip.id),{personId:person,amount:'2',currency:'RUB',occurredAtMs:5000,message:'',sourceName:'Cash'},0,6000);assert.ok(a.changes().versions.donations!>revision);
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
test('screen projections retain calculations while attendance pagination excludes donor-only people',()=>{
 const store=new StreamStore(':memory:');try{
  const at=Date.now()-600000,id=store.startSession('owner','one',at,'platform',at);
  store.recordPoll(id,'owner',{startedAtMs:at,completedAtMs:at+60000,status:'complete',userIds:Array.from({length:122},(_,i)=>'viewer'+i)});
  store.streamSample(id,at,'game','Game','Stream',3);
  store.ingest({source:'donationalerts',accountId:'owner',externalId:'support',type:'donation',actor:{externalId:daDonorExternalId('Supporter'),displayName:'Supporter'},occurredAtMs:at+1000,receivedAtMs:at+1000,sourceTime:null,timeQuality:'provider',transport:'rest',payload:{amountMinor:'100',currency:'RUB'}});
  store.endSession(id,at+120000);
  const query={fromMs:0,toMs:Date.now(),summaryOnly:true,clockCompact:true,clockDay:'all',clockResolution:15};
  const read=(extra:Partial<Parameters<StreamStore['analytics']>[0]>={})=>{for(let i=0;i<1000;i++){const value=store.analytics({...query,...extra});if(!value.preparing)return value;}throw Error('Fixture did not complete');};
  const full=read();assert.equal(full.summary.entities,123);assert.equal(full.summary.attendees,122);
  const audience=read({panel:'audience',attendanceOnly:true});assert.equal(audience.audiencePage?.total,122);assert.equal(audience.audience.length,100);assert.ok(audience.audience.every(p=>p.attendanceSessionIds.length));
  const last=read({panel:'audience',attendanceOnly:true,audienceOffset:100});assert.equal(last.audience.length,22);
  const dynamics=read({panel:'dynamics'});assert.deepEqual(dynamics.summary,full.summary);assert.deepEqual(dynamics.streamComparison,full.streamComparison);assert.deepEqual(dynamics.audience,[]);assert.deepEqual(dynamics.activityClock,[]);
  assert.ok(JSON.stringify(dynamics).length<JSON.stringify(full).length/3,'dynamics must not transfer attendance and hourly payloads');
 }finally{store.close();}
});
