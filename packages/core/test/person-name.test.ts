import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const at=Date.UTC(2026,9,31);
const yt=(id:string,name:string)=>({id,snippet:{type:'textMessageEvent',publishedAt:new Date(at).toISOString()},authorDetails:{channelId:'egor-youtube',displayName:name}});
test('explicit person name survives when equal to an old YouTube alias; accounts and statistics stay on one person',()=>{
 const s=new StreamStore(':memory:');try{
  const person=s.ingest({source:'twitch',accountId:'owner',externalId:'chat',type:'chat.message',actor:{externalId:'egor-twitch',displayName:'chikist007'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{}}).personId!;
  s.youtubeMessages('youtube-owner','chat',[yt('before','Егор4ик')]);
  const source=s.candidatePersons('Егор4ик')[0]!;s.merge(source,person,s.personRevision(source),s.personRevision(person),at);
  s.renamePerson(person,'Егор4ик');
  s.youtubeMessages('youtube-owner','chat',[yt('after','@egorbarinov6515')]);
  s.updateChatterNames('owner',[{user_id:'egor-twitch',user_name:'chikist007_next'}],at);
  assert.equal(s.person(person).display_name,'Егор4ик');
  assert.equal(s.personStats(person).messageCount,3);
  assert.equal(s.personsPage('',[],0,0,50).total,1);
  assert.deepEqual(s.candidatePersons('@egorbarinov6515'),[person]);
 }finally{s.close();}
});
test('assignment keeps only current donation recipient and revision, without assignment history',()=>{
 const s=new StreamStore(':memory:');try{
  const a=String(s.createPerson('First').id),b=String(s.createPerson('Second').id);
  const tip=s.createDonation({personId:a,amount:'10',currency:'RUB',occurredAtMs:at,message:'',sourceName:'Manual'},at);
  s.reassignDonation(tip.id,b,0,at+1);s.reassignDonation(tip.id,a,1,at+2);
  assert.equal(s.donation(tip.id).personId,a);assert.equal(s.donation(tip.id).revision,2);
  assert.deepEqual(s.donationAudit(tip.id).map(r=>r.kind),['create']);
  assert.equal(s.personStats(a).donationCount,1);assert.equal(s.personStats(b).donationCount,0);
 }finally{s.close();}
});

test('saving the same donation recipient is a no-op and a named reassignment does not create Anonymous',()=>{
 const s=new StreamStore(':memory:');try{
  const a=String(s.createPerson('First').id),b=String(s.createPerson('Second').id);
  const tip=s.createDonation({personId:a,amount:'10',currency:'RUB',occurredAtMs:at,message:'',sourceName:'Manual'},at);
  const before=(s.person(a).identities as unknown[]).length;
  assert.equal(s.reassignDonation(tip.id,a,0,at+1).revision,0);
  assert.equal((s.person(a).identities as unknown[]).length,before);
  s.reassignDonation(tip.id,b,0,at+2);
  assert.equal(s.persons('Аноним').length,0);
  assert.equal(s.reassignDonation(tip.id,b,1,at+3).revision,1);
  assert.throws(()=>s.reassignDonation(tip.id,b,0,at+4),/DONATION_CONFLICT/);
 }finally{s.close();}
});
test('legacy combined cards keep donor-equal human names during staggered profile migration and later provider updates',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-person-names-')),path=join(dir,'data.sqlite');
 let a:StreamStore|undefined,b:StreamStore|undefined;
 const chat=(s:StreamStore,user:string)=>s.ingest({source:'twitch',accountId:'owner',externalId:user,type:'chat.message',actor:{externalId:user,displayName:user},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{}}).personId!;
 try{
  a=new StreamStore(path,'ruslan');b=new StreamStore(path,'gulnaz');
  for(const s of [a,b]){
   const person=chat(s,'chikist007');chat(s,'other');s.youtubeMessages('yt-owner','chat',[yt('before','@egorbarinov6515')]);
   const other=s.candidatePersons('@egorbarinov6515')[0]!;
   if(other!==person)s.merge(other,person,s.personRevision(other),s.personRevision(person),at);
   s.renamePerson(s.candidatePersons('chikist007')[0]!,'Егор4ик');
  }
  a.close();a=undefined;b.close();b=undefined;
  const raw=new Database(path);for(const profile of ['ruslan','gulnaz'])raw.exec(`DROP TABLE p_${profile}_person_names`);raw.prepare('UPDATE sp_profile_schema SET version=29').run();raw.close();
  a=new StreamStore(path,'ruslan');const person=a.candidatePersons('chikist007')[0]!,other=a.candidatePersons('other')[0]!;
  a.merge(other,person,a.personRevision(other),a.personRevision(person),at+1);
  a.youtubeMessages('yt-owner','chat',[yt('after','New YouTube Name')]);assert.equal(a.person(person).display_name,'Егор4ик');
  b=new StreamStore(path,'gulnaz');const bp=b.candidatePersons('chikist007')[0]!;b.youtubeMessages('yt-owner','chat',[yt('after','Next YouTube Name')]);assert.equal(b.person(bp).display_name,'Егор4ик');
 }finally{a?.close();b?.close();rmSync(dir,{recursive:true,force:true});}
});
