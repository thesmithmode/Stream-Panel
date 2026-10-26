import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';
import {audienceAnalytics} from '../src/analytics.js';
const at=Date.UTC(2026,9,1),minute=60000;
function stream(s:StreamStore,start=at){const id=s.startSession('owner',String(start),start,'platform',start);s.streamSample(id,start,'game','Game','Title',6);s.recordPoll(id,'owner',{startedAtMs:start,completedAtMs:start+minute,status:'complete',userIds:['viewer'],userNames:{viewer:'Viewer'}});s.ingest({source:'twitch',accountId:'owner',externalId:String(start),type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:start+minute,receivedAtMs:start+minute,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{count:1}});s.endSession(id,start+20*minute);return id;}
test('late money corrections reuse durable attendance after restart; unrelated metadata and channel snapshots do not dirty facts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'stream-facts-')),path=join(dir,'data.sqlite');let s=new StreamStore(path);
 try{
  const id=stream(s),q={sessionId:id,fromMs:0,toMs:at+86400000,ownerId:'owner'},first=s.analytics(q),person=first.audience[0]!.id;
  const db=(s as any).db;const revision=()=>db.prepare('SELECT * FROM analytics_fact_versions WHERE session_id=?').get(id);
  const before=revision();s.createPersonNote(person,'note',at);s.followingSnapshot('twitch','owner',[{id:'viewer',name:'Viewer',followedAtMs:at}],true,at);s.youtubeSnapshot('yt','report',{total:42},at);assert.deepEqual(revision(),before);
  s.close();s=new StreamStore(path);const facts=(s as any).history.facts,load=facts.load.bind(facts);let attendanceReads=0;
  facts.load=(table:string,id:string,key:string,revision:number,build:()=>unknown,complete:boolean)=>load(table,id,key,revision,()=>{if(table==='analytics_stream_facts')attendanceReads++;return build();},complete);
  s.createDonation({personId:person,amount:'11',currency:'RUB',occurredAtMs:at+minute,message:'Late',sourceName:'Cash'},at+86400000);
  const report=s.analytics(q);assert.equal(report.summary.messages,first.summary.messages);assert.deepEqual(report.audience[0]!.donations,{RUB:'1100'});assert.equal(attendanceReads,0);
  assert.deepEqual(report.categories,audienceAnalytics((s as any).reads,q).categories);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('durable jobs coalesce, survive restart, remain profile-scoped, and finish without altering facts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'analytics-jobs-')),path=join(dir,'data.sqlite');let s=new StreamStore(path,'ruslan');
 try{
  const id=stream(s);const count=()=>((s as any).db.prepare('SELECT count(*) n FROM analytics_jobs').get().n);assert.equal(count(),1);
  s.streamSample(id,at+minute,'game','Game','Title',4);assert.equal(count(),1);s.close();s=new StreamStore(path,'ruslan');assert.equal(count(),1);
  const peer=new StreamStore(path,'gulnaz');try{assert.equal((peer as any).db.prepare('SELECT count(*) n FROM analytics_jobs').get().n,0);}finally{peer.close();}
  const before=s.changeStamp();assert.equal(s.advanceAnalytics({fromMs:0,toMs:at+86400000,ownerId:'owner'}).pending,0);assert.equal(count(),0);assert.equal(s.changeStamp(),before);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('category online uses known observation time, not unique people divided by broadcast hours',()=>{
 const s=new StreamStore(':memory:');try{stream(s);const report=s.analytics({fromMs:0,toMs:at+86400000,ownerId:'owner'}),category=report.categories[0]!;assert.equal(category.meanOnline,6);assert.ok(category.viewerCoverageRatio!>0&&category.viewerCoverageRatio!<1);assert.equal(category.observedPerKnownMinute,1);}finally{s.close();}
});
test('matching stream keeps Moscow day, nearest start, latest semantics and profile isolation',()=>{
 const s=new StreamStore(':memory:');try{const a=stream(s,at+21*60*minute),b=stream(s,at+23*60*minute);assert.equal(s.matchingStream(at+22*60*minute+30*minute),b);assert.equal(s.matchingStream(at),null);assert.equal(s.matchingStream(at,true),b);assert.notEqual(a,b);}finally{s.close();}
});
test('repeated samples and alias observation timestamps never dirty finished activity',()=>{
 const s=new StreamStore(':memory:');try{const id=stream(s),db=(s as any).db,read=()=>db.prepare('SELECT activity FROM analytics_fact_versions WHERE session_id=?').get(id).activity,before=read();
  s.streamSample(id,at,'game','Game','Title',6);assert.equal(read(),before);
  db.prepare('UPDATE identity_aliases SET last_seen_ms=last_seen_ms+60000').run();assert.equal(read(),before);
  s.followingSnapshot('twitch','owner',[],true,at+minute);assert.equal(read(),before);
 }finally{s.close();}
});
test('category averages weight measured viewer-minutes, including known zero and excluding unknown time',()=>{
 const s=new StreamStore(':memory:');try{
  const insert=(s as any).db.prepare("INSERT INTO stream_samples VALUES(?,?,'game','Game','',?,NULL)");let start=at;
  for(const [hours,viewers] of [[3,3],[4,22],[93,0]]){const id=s.startSession('owner',String(start),start,'platform',start);(s as any).db.transaction(()=>{for(let m=0;m<hours!*60;m++)insert.run(id,start+m*minute,viewers);})();s.endSession(id,start+hours!*60*minute);start+=hours!*60*minute;}
  const category=audienceAnalytics((s as any).reads,{fromMs:at,toMs:start,ownerId:'owner'}).categories[0]!;
  assert.equal(category.meanOnline,.97);assert.equal(category.viewerCoverageRatio,1);
 }finally{s.close();}
});
test('rolling clip projections are bounded while full finished-stream facts remain retained',()=>{
 const s=new StreamStore(':memory:');try{const id=stream(s),q={fromMs:0,toMs:at+86400000,sessionId:id,ownerId:'owner'};s.analytics(q);
  for(let i=1;i<8;i++)assert.deepEqual(s.analytics({...q,fromMs:at+i*minute}).summary,audienceAnalytics((s as any).reads,{...q,fromMs:at+i*minute}).summary);
  for(const table of ['analytics_stream_facts','analytics_money_facts']){const rows=(s as any).db.prepare(`SELECT complete,count(*) n FROM ${table} WHERE session_id=? GROUP BY complete`).all(id);assert.equal(rows.find((r:any)=>r.complete===1).n,1);assert.ok(rows.find((r:any)=>r.complete===0).n<=4);}
 }finally{s.close();}
});
test('collection can write during a consistent analytics read without publishing clock data under a newer revision',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-read-snapshot-')),path=join(dir,'data.sqlite'),s=new StreamStore(path);let peer:StreamStore|undefined;
 try{
  const id=stream(s);peer=new StreamStore(path);const facts=(s as any).history.facts,connection=facts.db;let changed=false;
  facts.db=new Proxy(connection,{get(target,property){if(property==='prepare')return(sql:string)=>{const statement=target.prepare(sql);if(!sql.includes('FROM stream_samples'))return statement;return new Proxy(statement,{get(stmt,key){if(key==='all')return(...args:unknown[])=>{if(!changed){changed=true;peer!.streamSample(id,at,'game','Game','Title',9);}return stmt.all(...args);};const value=Reflect.get(stmt,key,stmt);return typeof value==='function'?value.bind(stmt):value;}});};const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});
  const query={fromMs:0,toMs:at+86400000,sessionId:id,ownerId:'owner'};
  assert.equal(s.analytics(query).streamComparison[0]!.viewers.known.mean,6);assert.equal(changed,true);
  assert.equal(s.analytics(query).streamComparison[0]!.viewers.known.mean,9);
 }finally{peer?.close();s.close();rmSync(dir,{recursive:true,force:true});}
});
test('changed streams take priority over initial backfill and serial batches drain durable work',()=>{
 const s=new StreamStore(':memory:');try{
  const older=stream(s),changed=stream(s,at+86400000),db=(s as any).db;db.prepare('UPDATE analytics_jobs SET priority=0,requested_at_ms=0').run();
  s.streamSample(changed,at+86400000,'game','Game','Title',9);
  const q={fromMs:0,toMs:at+3*86400000,ownerId:'owner'};(s as any).history.advanceOne(q);
  assert.equal(db.prepare('SELECT count(*) n FROM analytics_jobs WHERE session_id=?').get(changed).n,0);assert.equal(db.prepare('SELECT count(*) n FROM analytics_jobs WHERE session_id=?').get(older).n,1);
  assert.equal(s.advanceAnalytics(q).pending,0);
 }finally{s.close();}
});

test('former bot aliases invalidate financial facts only for associated streams and restore totals when removed',()=>{
 const s=new StreamStore(':memory:');try{const id=stream(s),other=s.startSession('owner','unrelated',at+86400000,'platform',at+86400000);s.endSession(other,at+86400000+minute);
  const q={fromMs:0,toMs:at+2*86400000,sessionId:id,ownerId:'owner'},person=s.analytics(q).audience[0]!.id;
  s.createDonation({personId:person,amount:'11',currency:'RUB',occurredAtMs:at+minute,message:'',sourceName:'Cash'},at+minute);s.analytics(q);
  const db=(s as any).db,identity=db.prepare("SELECT id FROM identities WHERE source='twitch' AND external_id='viewer'").get().id;
  const before=db.prepare('SELECT * FROM analytics_fact_versions WHERE session_id=?').get(other);
  const compare=()=>{const actual=s.analytics(q),expected=audienceAnalytics((s as any).reads,q);assert.deepEqual(actual.categories,expected.categories);assert.deepEqual(actual.audience.map(p=>[p.id,p.donations]),expected.audience.map(p=>[p.id,p.donations]));};
  db.prepare('INSERT INTO identity_aliases VALUES(?,?,?,?,?)').run(identity,'Nightbot','nightbot',at,at);compare();assert.equal(s.analytics(q).audience.length,0);
  db.prepare('UPDATE identity_aliases SET candidate_key=? WHERE identity_id=? AND name=?').run('viewer',identity,'Nightbot');compare();assert.equal(s.analytics(q).audience.length,1);
  db.prepare('UPDATE identity_aliases SET candidate_key=? WHERE identity_id=? AND name=?').run('nightbot',identity,'Nightbot');compare();
  db.prepare('DELETE FROM identity_aliases WHERE identity_id=? AND name=?').run(identity,'Nightbot');compare();assert.equal(s.analytics(q).categories[0]!.donationTotals.RUB,'1100');
  assert.deepEqual(db.prepare('SELECT * FROM analytics_fact_versions WHERE session_id=?').get(other),before);
 }finally{s.close();}
});
