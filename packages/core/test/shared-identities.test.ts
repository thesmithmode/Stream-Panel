import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {StreamStore} from '../src/store.js';
import {daDonorExternalId} from '../src/domain.js';
const at=Date.UTC(2026,9,19,12),minute=60000;
let sequence=0;
function tw(s:StreamStore,user:string,name:string,time=at){return s.ingest({source:'twitch',accountId:'owner',externalId:`tw-${++sequence}`,type:'chat.message',actor:{externalId:user,displayName:name},occurredAtMs:time,receivedAtMs:time,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hi'}}).personId!;}
function da(s:StreamStore,name:string,time=at){return s.ingest({source:'donationalerts',accountId:'da',externalId:`da-${++sequence}`,type:'donation',actor:{externalId:daDonorExternalId(name),displayName:name},occurredAtMs:time,receivedAtMs:time,sourceTime:null,timeQuality:'provider',transport:'rest',payload:{amountMinor:'100',currency:'RUB'}}).personId!;}
function yt(s:StreamStore,channel:string,name:string,time=at){s.youtubeMessages('yt-owner','chat',[{id:`yt-${++sequence}`,snippet:{type:'textMessageEvent',publishedAt:new Date(time).toISOString(),displayMessage:'hi'},authorDetails:{channelId:channel,displayName:name}}]);return personOf(s,`youtube:${channel}`)!;}
const raw=(s:StreamStore)=>(s as any).db as Database.Database;
function personOf(s:StreamStore,key:string):string|null{return (raw(s).prepare('SELECT person_id FROM identity_link_keys WHERE link_key=? ORDER BY person_id LIMIT 1').get(key) as {person_id:string}|undefined)?.person_id??null;}
function groups(s:StreamStore){
 const rows=raw(s).prepare('SELECT person_id,link_key FROM identity_link_keys ORDER BY link_key').all() as {person_id:string;link_key:string}[],map=new Map<string,string[]>();
 for(const row of rows)map.set(row.person_id,[...map.get(row.person_id)??[],row.link_key]);
 return [...map.values()].map(keys=>keys.join('+')).sort();
}
const merge=(s:StreamStore,source:string,target:string,time=at)=>s.merge(source,target,s.personRevision(source),s.personRevision(target),time);
const queue=(s:StreamStore)=>(raw(s).prepare('SELECT count(*) n FROM identity_sync_queue').get() as {n:number}).n;
function files(){const dir=mkdtempSync(join(tmpdir(),'sp-shared-identities-'));return {path:join(dir,'data.sqlite'),done:()=>rmSync(dir,{recursive:true,force:true})};}

test('a merge, its undo, a split and its undo in one profile apply at once to every profile; names, notes and events stay per profile',()=>{
 const {path,done}=files(),a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz');
 try{
  const aTw=tw(a,'100','chikist007'),aYt=yt(a,'UCegor','@egorbarinov');da(a,'Егор4ик');
  tw(b,'100','chikist007');const bYt=yt(b,'UCegor','@egorbarinov'),bDa=da(b,'Егор4ик');
  b.renamePerson(bYt,'Гульназ name');b.createPersonNote(bYt,'only gulnaz',at);
  assert.deepEqual(groups(b),['da:егор4ик','twitch:100','youtube:UCegor']);
  merge(a,aYt,aTw);
  // The renamed gulnaz group keeps its own name and receives the other account.
  assert.deepEqual(groups(b),['da:егор4ик','twitch:100+youtube:UCegor']);
  assert.equal(personOf(b,'twitch:100'),bYt);assert.equal(b.person(bYt).display_name,'Гульназ name');
  assert.equal(b.events(undefined,bYt).length,2);assert.equal(a.person(aTw).display_name,'chikist007');
  assert.equal(queue(a)+queue(b),0);
  assert.deepEqual(a.syncSharedIdentities(),['gulnaz']);assert.deepEqual(a.syncSharedIdentities(),[]);
  // A merge in the second profile extends the same group in the first one without echoing back.
  merge(b,bDa,bYt);
  assert.deepEqual(groups(a),['da:егор4ик+twitch:100+youtube:UCegor']);
  assert.equal(a.person(aTw).display_name,'chikist007');
  assert.deepEqual(b.syncSharedIdentities(),['ruslan']);
  // Undoing the replicated merge in the first profile undoes the original one in the second.
  a.undoMerge(String(a.merges()[0]!.id),at+1);
  assert.deepEqual(groups(a),['da:егор4ик','twitch:100+youtube:UCegor']);
  assert.deepEqual(groups(b),['da:егор4ик','twitch:100+youtube:UCegor']);
  assert.ok(b.merges().find(m=>m.source_person_id===bDa)!.undone_at_ms);
  assert.equal(b.personNotes(bYt).length,1);
  // A split in the second profile, then its undo.
  const ytIdentity=(b.person(bYt).identities as any[]).find(i=>i.external_id==='UCegor');
  b.splitIdentities([ytIdentity.id],'Ютуб',b.personRevision(bYt),at+2);
  assert.deepEqual(groups(a),['da:егор4ик','twitch:100','youtube:UCegor']);
  assert.equal(personOf(a,'twitch:100'),aTw);assert.equal(a.person(aTw).display_name,'chikist007');
  assert.equal(personOf(b,'twitch:100'),bYt);assert.equal(b.person(bYt).display_name,'Гульназ name');
  b.undoSplit(String(b.splits()[0]!.id),at+3);
  assert.deepEqual(groups(a),['da:егор4ик','twitch:100+youtube:UCegor']);
  assert.deepEqual(groups(b),['da:егор4ик','twitch:100+youtube:UCegor']);
  assert.ok(a.splits()[0]!.undone_at_ms);assert.equal(personOf(a,'youtube:UCegor'),aTw);
  assert.equal(queue(a)+queue(b),0);
 }finally{a.close();b.close();done();}
});

test('groups that differ between profiles become their union, transitively, and nicknames match after normalization',()=>{
 const {path,done}=files(),a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz');
 try{
  const aTw=tw(a,'200','viewer_one'),aYt=yt(a,'UCtwo','Second channel');
  const bYt=yt(b,'UCtwo','Second channel'),bDa=da(b,' @Донатер ');
  merge(a,aYt,aTw);merge(b,bDa,bYt);
  // Profile A has never seen the nickname; it joins as soon as it donates.
  const aDa=da(a,'донатер');
  assert.equal(aDa,aTw);
  assert.deepEqual(groups(a),['da:донатер+twitch:200+youtube:UCtwo']);
  const bTw=tw(b,'200','renamed_viewer');
  assert.equal(bTw,personOf(b,'youtube:UCtwo'));
  assert.deepEqual(groups(b),['da:донатер+twitch:200+youtube:UCtwo']);
  assert.equal((raw(a).prepare("SELECT kind FROM membership_operations WHERE json_extract(after_json,'$[0].how')='shared_link'").all()).length>=1,true);
 }finally{a.close();b.close();done();}
});

test('a presence-only viewer without a name attaches to its shared group',()=>{
 const {path,done}=files(),a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz');
 try{
  const aTw=tw(a,'300','lurker'),aYt=yt(a,'UClurk','Lurker YT');merge(a,aYt,aTw);
  const bYt=yt(b,'UClurk','Lurker YT'),session=b.startSession('owner','s',at,'platform',at);
  b.recordPoll(session,'owner',{startedAtMs:at,completedAtMs:at+minute,status:'complete',userIds:['300']});
  assert.equal(personOf(b,'twitch:300'),bYt);
  b.recordPoll(session,'owner',{startedAtMs:at+minute,completedAtMs:at+2*minute,status:'complete',userIds:['301']});
  assert.notEqual(personOf(b,'twitch:301'),bYt);
 }finally{a.close();b.close();done();}
});

test('rollout joins existing groups of every profile once, idempotently, and rebuilds only streams of changed people',()=>{
 const {path,done}=files();let a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz');
 let owner:string,s1:string,s2:string;
 try{
  // Before rollout: ruslan has four separate accounts; gulnaz has three of them plus an unrelated viewer.
  owner=tw(a,'100','chikist007');yt(a,'UCegor','@egorbarinov');da(a,'Егор4ик');da(a,'Egor4ik');
  s1=b.startSession('owner','one',at,'platform',at);tw(b,'100','chikist007',at+minute);yt(b,'UCegor','@egorbarinov',at+minute);da(b,'Egor4ik',at+minute);b.endSession(s1,at+10*minute);
  s2=b.startSession('owner','two',at+86400000,'platform',at+86400000);tw(b,'900','stranger',at+86400000+minute);b.endSession(s2,at+86400000+10*minute);
 }finally{a.close();b.close();}
 // Rewind the file to schema 28 and group ruslan's accounts the way an earlier manual merge did.
 const db=new Database(path);let stable:unknown,affected:unknown;
 try{
  db.exec('DROP TABLE sp_identity_links;DROP TABLE sp_identity_sync_profiles;DROP TABLE sp_identity_sync_applied;UPDATE sp_profile_schema SET version=28');
  for(const profile of ['ruslan','gulnaz']){
   for(const {name,type} of db.prepare(`SELECT name,type FROM sqlite_master WHERE type IN ('trigger','view','index') AND (name LIKE 'p_${profile}_identity_sync%' OR name IN ('p_${profile}_identity_link_keys','p_${profile}_identities_external','p_${profile}_youtube_identities_external'))`).all() as {name:string;type:string}[])
    db.exec(`DROP ${type.toUpperCase()} IF EXISTS "${name}"`);
   db.exec(`DROP TABLE p_${profile}_identity_sync_queue`);
  }
  db.prepare("UPDATE p_ruslan_identities SET person_id=? WHERE source='donationalerts'").run(owner);
  db.prepare('UPDATE p_ruslan_youtube_identities SET person_id=?').run(owner);
  const version=db.prepare('SELECT activity,money FROM p_gulnaz_analytics_fact_versions WHERE session_id=?');
  stable=version.get(s2);affected=version.get(s1);
 }finally{db.close();}
 b=new StreamStore(path,'gulnaz');
 try{assert.deepEqual(groups(b),['da:egor4ik','twitch:100','twitch:900','youtube:UCegor']);}finally{b.close();}
 a=new StreamStore(path,'ruslan');b=new StreamStore(path,'gulnaz');
 try{
  assert.deepEqual(groups(a),['da:egor4ik+da:егор4ик+twitch:100+youtube:UCegor']);
  assert.deepEqual(groups(b),['da:egor4ik+twitch:100+youtube:UCegor','twitch:900']);
  assert.equal(b.person(personOf(b,'twitch:100')!).display_name,'chikist007');
  const versions=(id:string)=>raw(b).prepare('SELECT activity,money FROM analytics_fact_versions WHERE session_id=?').get(id);
  assert.deepEqual(versions(s2),stable);assert.notDeepEqual(versions(s1),affected);
  const snapshot=[versions(s2),versions(s1),b.changeStamp(),a.changeStamp(),groups(a),groups(b)];
  a.close();b.close();a=new StreamStore(path,'ruslan');b=new StreamStore(path,'gulnaz');
  assert.deepEqual([versions(s2),versions(s1),b.changeStamp(),a.changeStamp(),groups(a),groups(b)],snapshot);
  assert.deepEqual(a.syncSharedIdentities(),[]);assert.deepEqual(b.syncSharedIdentities(),[]);
 }finally{a.close();b.close();done();}
});

test('a nickname binding moves the nickname in every profile and the losing group keeps its other accounts',()=>{
 const {path,done}=files(),a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz');
 try{
  const aTw=tw(a,'400','owner_of_nick');merge(a,da(a,'SharedNick'),aTw);
  const bTw=tw(b,'400','owner_of_nick');da(b,'SharedNick');
  assert.equal(personOf(b,'da:sharednick'),bTw);
  const aOther=tw(a,'401','real_donor'),bOther=tw(b,'401','real_donor');
  a.bindDonorNickname(aOther,'SharedNick',a.personRevision(aOther),at);
  assert.equal(personOf(a,'da:sharednick'),aOther);assert.equal(personOf(b,'da:sharednick'),bOther);
  assert.equal(personOf(b,'twitch:400'),bTw);
  assert.equal((raw(b).prepare('SELECT person_id FROM donor_bindings WHERE name_key=?').get('sharednick') as {person_id:string}).person_id,bOther);
  assert.equal(da(b,'sharednick'),bOther);
 }finally{a.close();b.close();done();}
});

test('accounts one profile keeps under several people stay local and never drag those people together',()=>{
 const {path,done}=files(),a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz');
 try{
  const tip=(account:string,id:string)=>b.ingest({source:'donationalerts',accountId:account,externalId:id,type:'donation',actor:{externalId:daDonorExternalId('Twin'),displayName:'Twin'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'rest',payload:{amountMinor:'100',currency:'RUB'}}).personId!;
  // gulnaz keeps the same nickname of two DonationAlerts accounts under two different people.
  const bOne=tw(b,'500','first'),bTwo=tw(b,'501','second');
  merge(b,tip('da-1','x1'),bOne);
  const second=tip('da-2','x2');
  const twin=(b.person(personOf(b,'twitch:500')!).identities as any[]).find(i=>i.account_id==='da-2');
  if(twin)merge(b,b.splitIdentities([twin.id],'Twin',b.personRevision(bOne),at),bTwo);else merge(b,second,bTwo);
  assert.notEqual(personOf(b,'twitch:500'),personOf(b,'twitch:501'));
  // ruslan links the nickname with one of them: gulnaz's ambiguous nickname does not merge its two people.
  const aOne=tw(a,'500','first'),aTwin=da(a,'Twin');merge(a,aTwin,aOne);
  assert.notEqual(personOf(b,'twitch:500'),personOf(b,'twitch:501'));
  assert.equal((b.person(bOne).identities as any[]).length,2);assert.equal((b.person(bTwo).identities as any[]).length,2);
  // A link through unambiguous accounts still applies.
  const aTwo=tw(a,'501','second');merge(a,aTwo,aOne);
  assert.equal(personOf(b,'twitch:500'),personOf(b,'twitch:501'));
 }finally{a.close();b.close();done();}
});

test('a change in one profile invalidates only the streams of affected people in the other profile',()=>{
 const {path,done}=files(),a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz');
 try{
  const aTw=tw(a,'600','alpha'),aYt=yt(a,'UCalpha','Alpha YT');
  const s1=b.startSession('owner','one',at,'platform',at);tw(b,'600','alpha',at+minute);b.endSession(s1,at+10*minute);
  const s2=b.startSession('owner','two',at+86400000,'platform',at+86400000);tw(b,'601','beta',at+86400000+minute);b.endSession(s2,at+86400000+10*minute);
  yt(b,'UCalpha','Alpha YT',at+2*86400000);
  const v=(id:string)=>raw(b).prepare('SELECT activity,money FROM analytics_fact_versions WHERE session_id=?').get(id);
  const before=[v(s1),v(s2)],stamp=b.changeStamp();
  merge(a,aYt,aTw);
  assert.notDeepEqual(v(s1),before[0]);assert.deepEqual(v(s2),before[1]);assert.notEqual(b.changeStamp(),stamp);
  const after=[v(s1),v(s2),a.changeStamp(),b.changeStamp()];
  assert.deepEqual(a.syncSharedIdentities(),['gulnaz']);
  for(let i=0;i<3;i++){assert.deepEqual(a.syncSharedIdentities(),[]);assert.deepEqual(b.syncSharedIdentities(),[]);}
  assert.deepEqual([v(s1),v(s2),a.changeStamp(),b.changeStamp()],after);
 }finally{a.close();b.close();done();}
});

test('a single-profile or legacy store keeps working without shared groups',()=>{
 const s=new StreamStore(':memory:');
 try{const one=tw(s,'700','solo'),two=yt(s,'UCsolo','Solo YT');merge(s,two,one);assert.deepEqual(s.syncSharedIdentities(),[]);assert.equal(personOf(s,'youtube:UCsolo'),one);}
 finally{s.close();}
});

// Hosted startup opens ruslan before gulnaz. A profile whose keys are already in
// the journal must still apply those links, even when publishing changes no keys.
for(const order of [['ruslan','gulnaz'],['gulnaz','ruslan']] as const)for(const version of [28,29]){
 test(`existing v${version} groups converge with ${order.join(' then ')} startup and cached stream reports`,()=>{
  const {path,done}=files();let a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz');
  const ids:string[]=[],people:string[]=[],before:ReturnType<StreamStore['analytics']>[]=[],query={fromMs:0,toMs:at+86400000,youtubeAccount:'yt-owner',ownerId:'owner'};
  try{
   for(const [index,store] of [a,b].entries()){
    const id=store.startSession('owner',`startup-${index}`,at,'platform',at);ids.push(id);
    store.attachPlatformStream(id,'youtube','yt-owner',`video-${index}`,at,at,null,'Video');
    const person=tw(store,'startup-viewer','Twitch viewer',at+minute);people.push(person);
    yt(store,'UCstartup','YouTube viewer',at+minute);
    store.recordPoll(id,'owner',{startedAtMs:at,completedAtMs:at+(index+2)*minute,status:'complete',userIds:['startup-viewer']});
    store.createDonation({personId:person,amount:String(index+1),currency:'RUB',occurredAtMs:at+minute,message:'',sourceName:'Cash'},at+minute);
    store.endSession(id,at+10*minute);
    before.push(store.analytics({...query,sessionId:id}));
    assert.equal(before[index]!.audience.length,2);
   }
   a.close();b.close();
   const db=new Database(path);
   try{
    // Reproduce the pre-release local grouping: only ruslan joined these accounts.
    db.prepare('UPDATE p_ruslan_youtube_identities SET person_id=?').run(people[0]);
    db.exec('DELETE FROM sp_identity_links;DELETE FROM p_ruslan_identity_sync_queue;DELETE FROM p_gulnaz_identity_sync_queue');
    db.exec('DROP TABLE IF EXISTS sp_identity_sync_applied');
    if(version===28){
     db.exec('DROP TABLE sp_identity_links;DROP TABLE sp_identity_sync_profiles;UPDATE sp_profile_schema SET version=28');
     for(const profile of ['ruslan','gulnaz']){
      for(const row of db.prepare("SELECT name,type FROM sqlite_master WHERE type IN ('trigger','view','index') AND (name LIKE ? OR name IN (?,?,?))").all(`p_${profile}_identity_sync%`,`p_${profile}_identity_link_keys`,`p_${profile}_identities_external`,`p_${profile}_youtube_identities_external`) as {name:string;type:string}[])
       db.exec(`DROP ${row.type.toUpperCase()} IF EXISTS "${row.name}"`);
      db.exec(`DROP TABLE p_${profile}_identity_sync_queue`);
     }
    }else{
     // The shipped v29 bug marked both profiles joined but left gulnaz split.
     db.prepare('INSERT INTO sp_identity_links VALUES(?,?,?)').run('twitch:startup-viewer','startup-cluster',at);
     db.prepare('INSERT INTO sp_identity_links VALUES(?,?,?)').run('youtube:UCstartup','startup-cluster',at);
    }
   }finally{db.close();}
   const opened=order.map(profile=>new StreamStore(path,profile));
   a=opened[order.indexOf('ruslan') as 0|1]!;b=opened[order.indexOf('gulnaz') as 0|1]!;
   for(const [index,store] of [a,b].entries()){
    assert.equal(personOf(store,'twitch:startup-viewer'),personOf(store,'youtube:UCstartup'));
    const report=store.analytics({...query,sessionId:ids[index]!});
    assert.equal(report.audience.length,1);
    assert.equal(report.summary.messages,before[index]!.summary.messages);
    assert.equal(report.audience[0]!.observedMinutes,before[index]!.audience.find(p=>p.observedMinutes>0)!.observedMinutes);
    assert.deepEqual(report.audience[0]!.donations,{RUB:String((index+1)*100)});
   }
   const snapshot=[groups(a),groups(b),a.changeStamp(),b.changeStamp()];
   a.syncSharedIdentities();b.syncSharedIdentities();
   a.close();b.close();a=new StreamStore(path,'ruslan');b=new StreamStore(path,'gulnaz');
   assert.deepEqual([groups(a),groups(b),a.changeStamp(),b.changeStamp()],snapshot);
   for(let i=0;i<3;i++){assert.deepEqual(a.syncSharedIdentities(),[]);assert.deepEqual(b.syncSharedIdentities(),[]);}
  }finally{a.close();b.close();done();}
 });
}
