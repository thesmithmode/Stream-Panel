import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';
import {ChannelRecords} from '../src/channel-records.js';
import {logicalReadDatabase} from '../src/session-groups.js';
import {openProfileDatabase} from '../src/profile-db.js';
test('records reuse unchanged stream facts across restarts and revisit only revisions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-records-')),path=join(dir,'db.sqlite');const store=new StreamStore(path,'ruslan');const db=logicalReadDatabase(openProfileDatabase(path,'ruslan'));
 try{
  const base=Date.now()-3600000;const a=store.startSession('a','a',base,'platform',base);store.endSession(a,base+60000);
  const b=store.startSession('b','b',base+120000,'platform',base);store.endSession(b,base+180000);
  let calls=0;
  const read=(id:string)=>{calls++;return {viewerKnownMean:id===a?5:3,messageCount:id===a?10:12};};
  const records=new ChannelRecords(db,read);
  assert.deepEqual(records.read('[]'),{online:{value:5,at:base},messages:{value:12,at:base+120000},peakOnline:null,peakChat:null});assert.equal(calls,2);
  records.read('[]');assert.equal(calls,2,'unchanged history does not load samples or messages');
  new ChannelRecords(db,read).read('[]');assert.equal(calls,2,'persisted projection survives a new reader');
  store.streamSample(b,base+120000,'','','',8);records.read('[]');assert.equal(calls,3,'only the modified stream is recomputed');
  records.read('["bot"]');assert.equal(calls,5,'bot filter changes invalidate both metrics');
  store.mergeSessions([a,b]);const merged=records.read('[]');assert.equal(calls,6);assert.equal(merged.messages?.value,10,'old group members cannot remain record holders');
  store.unmergeSessions(a);records.read('[]');assert.equal(calls,8);
 }finally{db.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
test('overview returns accurate online and message records and keeps the earliest tie',()=>{
 const store=new StreamStore(':memory:');try{
  const at=Date.now()-3600000;
  for(let n=0;n<2;n++){const id=store.startSession('owner',String(n),at+n*120000,'platform',at);store.streamSample(id,at+n*120000,'','','',5);store.endSession(id,at+n*120000+60000);}
  assert.deepEqual(store.channelOverview().records,{online:{value:5,at},messages:{value:0,at},peakOnline:{value:5,at},peakChat:null});
 }finally{store.close();}
});

test('historical simultaneous peaks keep the actual date, deduplicate linked people and persist independently of money and metadata',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-peak-records-')),path=join(dir,'facts.sqlite');let s=new StreamStore(path);
 try{
  const at=Date.UTC(2026,9,1,20,59),id=s.startSession('owner','midnight',at,'platform',at);
  s.streamSample(id,at,'game','Game','',3);s.streamSample(id,at+2*60000,'game','Game','',9);
  s.recordPoll(id,'owner',{startedAtMs:at+60000,completedAtMs:at+60000,status:'complete',userIds:['a','b','nightbot']});
  s.recordPoll(id,'owner',{startedAtMs:at+2*60000,completedAtMs:at+2*60000,status:'complete',userIds:['c']});s.endSession(id,at+3*60000);
  let records=s.channelOverview().records;assert.deepEqual(records.peakOnline,{value:9,at:at+2*60000});assert.deepEqual(records.peakChat,{value:2,at:at+60000});
  const people=s.persons(),a=people.find(p=>p.display_name==='a')!.id as string,b=people.find(p=>p.display_name==='b')!.id as string;
  s.merge(b,a,s.personRevision(b),s.personRevision(a),at+4*60000);records=s.channelOverview().records;assert.equal(records.peakChat?.value,1);
  const read=(s as any).history.recordMetrics.bind((s as any).history);let reads=0;(s as any).history.recordMetrics=(...args:any[])=>{reads++;return read(...args);};
  s.createPersonNote(a,'Note',at+5*60000);s.followingSnapshot('twitch','owner',[{id:'a',name:'a',followedAtMs:at}],true,at+5*60000);
  s.createDonation({personId:a,amount:'11',currency:'RUB',occurredAtMs:at+60000,message:'Late',sourceName:'Cash'},at+5*60000);
  assert.deepEqual(s.channelOverview().records,records);assert.equal(reads,0);
  s.close();s=new StreamStore(path);(s as any).history.recordMetrics=()=>{throw Error('unchanged historical records recomputed');};assert.deepEqual(s.channelOverview().records,records);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

test('background preparation includes overview records so opening the landing tab does not prepare them again',()=>{
 const s=new StreamStore(':memory:');try{const at=Date.now()-3600000,id=s.startSession('owner','warm-records',at,'platform',at);s.streamSample(id,at,'game','Game','',9);s.endSession(id,at+60000);
  let result;do{result=s.warmAnalytics({fromMs:0,toMs:Date.now(),ownerId:'owner'});}while(result.preparing);
  (s as any).history.recordMetrics=()=>{throw Error('landing page recalculated historical records');};assert.equal(s.channelOverview().records.peakOnline?.value,9);
 }finally{s.close();}
});
