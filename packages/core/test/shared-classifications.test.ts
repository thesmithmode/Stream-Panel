import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';
const at=Date.now()-3600000;
function user(s:StreamStore,owner:string,id:string,name=id){s.ingest({source:'twitch',accountId:owner,externalId:`chat-${id}`,type:'chat.message',actor:{externalId:id,displayName:name},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'Hello'}});return ((s as any).db.prepare("SELECT person_id FROM identities WHERE source='twitch' AND external_id=?").get(id) as {person_id:string}).person_id;}
test('manual labels share both ways by account ID, clear everywhere, preserve history and invalidate only affected caches',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-shared-classification-')),path=join(dir,'db');const a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz');
 try{
  const one=a.startSession('owner-a','one',at,'platform',at),two=b.startSession('owner-b','two',at,'platform',at);
  const x=user(a,'owner-a','42','Same name'),y=user(b,'owner-b','42','Renamed'),other=user(b,'owner-b','43','Same name');
  a.endSession(one,at+60000);b.endSession(two,at+60000);
  const before=a.personStats(x),peerBefore=b.personStats(y),q={sessionId:two,fromMs:at,toMs:at+60000};assert.equal(b.analytics(q).summary.attendees,2);
  const stale=b.personRevision(y);a.setPersonClassification(x,'bot',a.personRevision(x));
  assert.equal(b.personBot(y).manualBot,true);assert.equal(b.personBot(other).manualBot,false);assert.equal(b.analytics(q).summary.attendees,1);assert.throws(()=>b.setPersonClassification(y,'human',stale),/REVISION_CONFLICT/);
  assert.equal(a.personStats(x).messageCount,before.messageCount);assert.equal(b.personStats(y).messageCount,peerBefore.messageCount);
  b.setPersonClassification(y,'human',b.personRevision(y));assert.equal(a.personBot(x).manualHuman,true);assert.equal(a.personBot(x).manualBot,false);
  a.setPersonClassification(x,'unknown',a.personRevision(x));assert.equal(b.personBot(y).manualHuman,false);assert.equal(b.personBot(y).manualBot,false);
  const stamp=b.changeStamp();a.setPersonClassification(x,'unknown',a.personRevision(x));assert.equal(b.changeStamp(),stamp,'unchanged peer classification does not invalidate its caches');
  assert.deepEqual(b.syncSharedIdentities().sort(),['ruslan']);assert.deepEqual(b.syncSharedIdentities(),[]);
  const custom=user(a,'owner-a','49','custom-name'),customPeer=user(b,'owner-b','49','custom-name');assert.equal(b.personBot(customPeer,['custom-name']).knownBot,true);a.setPersonClassification(custom,'unknown',a.personRevision(custom));assert.equal(b.personBot(customPeer,['custom-name']).knownBot,false,'an explicit neutral choice overrides the peer profile custom bot list');
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
test('saved decisions reach accounts discovered later and survive restart, while automatic humans stay protected',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-classification-later-')),path=join(dir,'db');let a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz');
 try{
  const x=user(a,'owner-a','42');a.setPersonClassification(x,'bot',a.personRevision(x));
  const y=user(b,'owner-b','42');b.syncSharedIdentities();assert.equal(b.personBot(y).manualBot,true);
  a.close();b.close();a=new StreamStore(path,'ruslan');b=new StreamStore(path,'gulnaz');assert.equal(b.personBot(y).manualBot,true);
  b.setPersonClassification(y,'human',b.personRevision(y));assert.equal(a.personBot(x).manualHuman,true);
  b.createDonation({personId:y,amount:'1',currency:'RUB',occurredAtMs:at,message:'',sourceName:'Cash'},at);assert.throws(()=>a.setPersonClassification(x,'bot',a.personRevision(x)),/BOT_NOT_ELIGIBLE/);assert.equal(a.personBot(x).manualHuman,true);assert.equal(b.personBot(y).automaticHuman,true);assert.equal(b.personBot(y).manualBot,false);
  assert.equal(a.personBots([x])[x]!.manualHuman,true);assert.throws(()=>a.personBots(Array(101).fill(x)),/INVALID_PERSON_IDS/);assert.throws(()=>a.personBots(['']),/INVALID_PERSON_IDS/);assert.throws(()=>a.personBot('__proto__'),/PERSON_NOT_FOUND/);
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

test('existing marks reconcile once on upgrade, preferring a human to an undated conflicting bot',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-classification-upgrade-')),path=join(dir,'db');let a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz');
 try{
  const x=user(a,'owner-a','42'),y=user(b,'owner-b','42'),neutral=user(a,'owner-a','44','nightbot');user(b,'owner-b','44','nightbot');
  a.setPersonClassification(x,'bot',a.personRevision(x));a.setPersonClassification(neutral,'unknown',a.personRevision(neutral));
  // Reproduce independent marks from before sharing was introduced.
  const db=(b as any).db;db.prepare('DELETE FROM person_bot_marks WHERE identity_id IN(SELECT id FROM identities WHERE person_id=?)').run(y);db.prepare("INSERT OR IGNORE INTO person_human_marks SELECT id FROM identities WHERE person_id=? AND source='twitch' LIMIT 1").run(y);
  db.exec('DELETE FROM sp_person_classifications;DELETE FROM sp_classification_profiles');a.close();b.close();a=new StreamStore(path,'ruslan');b=new StreamStore(path,'gulnaz');
  assert.equal(a.personBot(x).manualHuman,true);assert.equal(a.personBot(x).manualBot,false);assert.equal(b.personBot(y).manualHuman,true);assert.equal(a.personBot(neutral).knownBot,false);
  a.syncSharedIdentities();const stamp=a.changeStamp();assert.deepEqual(a.syncSharedIdentities(),[]);assert.equal(a.changeStamp(),stamp);
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
