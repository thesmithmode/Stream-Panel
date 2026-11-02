import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';
import Database from 'better-sqlite3';
test('human name follows common account membership across profiles without renaming provider accounts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-common-name-'));const path=join(dir,'data.sqlite');
 const a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz'),at=Date.now();
 const seed=(s:StreamStore,account:string)=>s.ingest({source:'twitch',accountId:account,externalId:'message',type:'chat.message',actor:{externalId:'user',displayName:'AccountNick'},occurredAtMs:at,receivedAtMs:at,timeQuality:'provider',sourceTime:null,transport:'eventsub',payload:{}}).personId!;
 try{
  const ap=seed(a,'ruslan');a.renamePerson(ap,'Человек');const bp=seed(b,'gulnaz');b.syncSharedIdentities();
  assert.equal(b.person(bp).display_name,'Человек');
  assert.equal((a.person(ap).identities as {display_name:string}[])[0]!.display_name,'AccountNick');
  b.renamePerson(bp,'Общее имя');assert.equal(a.person(ap).display_name,'Общее имя');
  assert.equal(a.recentEvents()[0]!.person_name,'Общее имя');
  const session=a.startSession('ruslan','live',at,'platform',at);
  a.recordPoll(session,'ruslan',{startedAtMs:at,completedAtMs:at,status:'complete',userIds:['user']});
  assert.equal(a.currentChat(session,[],false,at).people[0]!.name,'Общее имя');
  assert.equal(a.currentChat(session,[],false,at).people[0]!.accountName,'AccountNick');
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
test('existing divergent human names converge once, independently of profile startup order',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-common-rollout-')),path=join(dir,'data.sqlite');
 let a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz');
 const at=Date.now();const seed=(s:StreamStore)=>s.ensureOwnerIdentity('owner','same-user','AccountNick',at);
 try{
  const ap=seed(a),bp=seed(b);a.renamePerson(ap,'Chosen name');a.close();b.close();
  const raw=new Database(path);raw.prepare('UPDATE p_gulnaz_persons SET display_name=? WHERE id=?').run('Legacy local name',bp);raw.prepare('DELETE FROM sp_identity_names_applied').run();raw.close();
  b=new StreamStore(path,'gulnaz');a=new StreamStore(path,'ruslan');
  assert.equal(a.person(ap).display_name,'Chosen name');assert.equal(b.person(bp).display_name,'Chosen name');
  assert.deepEqual(a.syncSharedIdentities(),[]);
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

test('a permanent Twitch user ID keeps one person across recipient channels and nickname changes',()=>{
 const s=new StreamStore(':memory:');const at=Date.now();
 const seed=(account:string,name:string)=>s.ingest({source:'twitch',accountId:account,externalId:'message',type:'chat.message',actor:{externalId:'same-user',displayName:name},occurredAtMs:at,receivedAtMs:at,timeQuality:'provider',sourceTime:null,transport:'eventsub',payload:{}}).personId!;
 try{const person=seed('first','OldNick');s.renamePerson(person,'Человек');assert.equal(seed('second','NewNick'),person);assert.equal(s.person(person).display_name,'Человек');}finally{s.close();}
});
