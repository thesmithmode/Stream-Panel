import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {StreamStore} from '../src/store.js';import {SubscriberHistory} from '../src/subscriber-history.js';import {openProfileDatabase} from '../src/profile-db.js';import {schemaMigrations} from '../src/schema.js';
test('subscriber history preserves provider dates outside streams, reconciles totals, and isolates profiles/accounts/platforms',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'subscriber-history-')),path=join(dir,'db');
 const a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz');
 try{
  a.followingSnapshot('twitch','owner',[],true,1000,10);
  a.followingSnapshot('twitch','owner',[{id:'viewer',name:'Viewer',followedAtMs:2500}],true,5000,11);
  a.followingSnapshot('twitch','owner',[{id:'viewer',name:'Viewer',followedAtMs:2500}],true,6000,11);
  a.followingSnapshot('twitch','owner',[],false,7000,null);
  b.followingSnapshot('twitch','owner',[],true,1000,999);
  a.followingSnapshot('twitch','other',[],true,1000,500);
  const event={source:'twitch' as const,accountId:'owner',externalId:'follow-1',type:'follow',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:2500,receivedAtMs:3000,sourceTime:null,timeQuality:'provider' as const,transport:'eventsub' as const,payload:{}};
  a.ingest(event);a.ingest(event);
  const stream=a.observePlatformStream('twitch','owner','stream',2000,2000,'https://twitch.tv/owner','Title')!;a.endSession(stream,4000);
  const q={source:'twitch' as const,account:'owner',from:1500,to:6500};const result=a.subscriberHistory(q);
  assert.equal(result.total,11);assert.equal(result.change,1);assert.equal(result.lastAt,6000);assert.deepEqual(result.follows,[{id:'viewer',name:'Viewer',at:2500}]);assert.equal(result.streams.length,1);assert.deepEqual(result.publications,[]);
  assert.equal(b.subscriberHistory(q).total,999);assert.equal(b.subscriberHistory(q).follows.length,0);assert.equal(a.subscriberHistory({...q,account:'none'}).total,null);
  a.youtubeSnapshot('yt','channel',{statistics:{subscriberCount:'287'}},1200);
  a.youtubeSnapshot('yt','channel',{statistics:{subscriberCount:'288'}},5500);
  a.youtubeSnapshot('yt','channel',{statistics:{subscriberCount:'999',hiddenSubscriberCount:true}},6000);
  a.youtubeSnapshot('yt','channel',{statistics:{subscriberCount:'bad'}},6100);
  a.followingSnapshot('youtube','yt',[],true,6300,42);
  const p={id:'video',title:'Video',publishedAt:3000,kind:'video' as const};a.youtubePublications('yt',[p],3500);a.youtubePublications('yt',[{...p,kind:'unknown'}],5000);
  const youtube=a.subscriberHistory({...q,source:'youtube',account:'yt'});assert.equal(youtube.total,288);assert.equal(youtube.change,1);assert.deepEqual(youtube.follows,[]);assert.equal(youtube.publications[0]?.kind,'video');assert.equal(b.subscriberHistory({...q,source:'youtube',account:'yt'}).total,null);
  assert.equal(a.subscriberHistory({...q,from:0}).change,null);assert.throws(()=>a.subscriberHistory({...q,source:'bad' as any}),/INVALID_/);assert.throws(()=>a.subscriberHistory({...q,from:NaN}),/INVALID_/);assert.throws(()=>a.subscriberHistory({...q,to:0}),/INVALID_/);assert.throws(()=>a.subscriberHistory({...q,to:32*86400000}),/INVALID_/);
  const raw=openProfileDatabase(path,'ruslan'),history=new SubscriberHistory(raw);
  try{assert.throws(()=>history.count('twitch','owner',-1,10),/INVALID_/);assert.throws(()=>history.count('bad' as any,'owner',1,10),/INVALID_/);assert.throws(()=>history.count('twitch','',1,10),/INVALID_/);assert.throws(()=>history.count('twitch','owner',1,NaN),/INVALID_/);assert.throws(()=>history.publications('',[],1),/INVALID_/);assert.throws(()=>history.publications('yt',[{...p,id:'bad/id'}],1),/INVALID_/);assert.throws(()=>history.publications('yt',[{...p,kind:'bad' as any}],1),/INVALID_/);assert.throws(()=>history.publications('yt',[{...p,publishedAt:-1}],1),/INVALID_/);assert.throws(()=>history.publications('yt',Array(1001).fill(p),1),/INVALID_/);assert.throws(()=>history.publications('yt',[{...p,title:null as any}],1),/INVALID_/);history.count('twitch','owner',15,10000);history.count('twitch','owner',16,10000);assert.equal(history.query({...q,to:11000}).total,16);}finally{raw.close();}
 }finally{a.close();b.close();await rm(dir,{recursive:true,force:true});}
});
test('schema 25 retains existing Twitch observations and does not misdate stale YouTube totals',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'subscriber-migration-')),path=join(dir,'db');
 try{const old=openProfileDatabase(path);for(const sql of schemaMigrations.slice(0,24))old.exec(sql);old.prepare("INSERT INTO provider_snapshots VALUES ('old','twitch','owner','followers',1000,NULL,?)").run(JSON.stringify({followers:[],complete:true,total:0}));old.prepare("INSERT INTO follower_checks VALUES ('check','old',1000,NULL)").run();old.prepare("INSERT INTO provider_snapshots VALUES ('yt','youtube','yt','followers',1000,NULL,?)").run(JSON.stringify({followers:[],complete:true,total:999}));old.prepare("INSERT INTO follower_checks VALUES ('yt-check','yt',1000,NULL)").run();old.close();const reopened=new StreamStore(path);assert.equal(reopened.subscriberHistory({source:'youtube',account:'yt',from:0,to:2000}).total,null);assert.equal(reopened.subscriberHistory({source:'twitch',account:'owner',from:0,to:2000}).total,0);reopened.close();}finally{await rm(dir,{recursive:true,force:true});}
});
