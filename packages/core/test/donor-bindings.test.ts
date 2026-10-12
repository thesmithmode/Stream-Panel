import test from 'node:test';import assert from 'node:assert/strict';import {StreamStore} from '../src/store.js';
const at=Date.now();const tip=(id:string,name:string)=>({source:'donationalerts' as const,accountId:'da',externalId:id,type:'donation',actor:{externalId:'name:'+name.toLowerCase(),displayName:name},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider' as const,transport:'rest' as const,payload:{amountMinor:'100',currency:'RUB'}});
test('nickname binding persists for past and future tips and respects explicit per-person selection',()=>{
 const db=new StreamStore(':memory:');try{
  const person=String(db.createPerson('Viewer').id);db.ingest(tip('old','DifferentNick'));
  const revision=Number(db.person(person).revision);db.bindDonorNickname(person,' @DifferentNick ',revision,at);
  assert.equal(db.donation(String(db.donations(person).items[0]!.id)).personId,person);assert.equal(db.donorBindings(person).length,1);
  const oldId=String(db.donations(person).items[0]!.id);
  const again=db.ingest(tip('old','DifferentNick'));assert.equal(again.inserted,false);assert.equal(db.donation(String(db.donations(person).items[0]!.id)).personId,person);
  db.ingest(tip('future','DIFFERENTNICK'));assert.equal(db.donation(String(db.donations(person).items[0]!.id)).personId,person);
  const second=String(db.createPerson('Other').id);db.bindDonorNickname(second,'differentnick',Number(db.person(second).revision),at+1);assert.equal(db.donation(oldId).personId,second);
  assert.throws(()=>db.bindDonorNickname(second,'new',-1,at),/REVISION_CONFLICT/);
  for(const name of ['','Anonymous','Аноним','x'.repeat(201)])assert.throws(()=>db.bindDonorNickname(second,name,Number(db.person(second).revision),at),/INVALID_DONOR_NICKNAME/);
  assert.throws(()=>db.donorBindings('missing'),/PERSON_NOT_FOUND/);
  const unobserved=String(db.createPerson('Future only').id);db.bindDonorNickname(unobserved,'newnick',Number(db.person(unobserved).revision),at);
  db.ingest(tip('newtip','NewNick'));assert.equal(db.donation(String(db.donations(unobserved).items[0]!.id)).personId,unobserved);
  assert.ok(db.donorNicknames().some(d=>d.name==='DIFFERENTNICK'));
 }finally{db.close();}
});

test('manual nickname rule survives profile database reopening and cannot be overwritten by automatic name reconciliation',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const dir=await mkdtemp(join(tmpdir(),'sp-donor-rules-')),path=join(dir,'data.sqlite');let db=new StreamStore(path,'ruslan');
 try{
  const person=String(db.createPerson('Manual target').id);db.bindDonorNickname(person,'DifferentNick',Number(db.person(person).revision),at);
  db.ingest(tip('bound','DifferentNick'));
  db.ingest({source:'twitch',accountId:'channel',externalId:'hello',type:'chat.message',actor:{externalId:'viewer',displayName:'DifferentNick'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'Hello'}});
  db.close();db=new StreamStore(path,'ruslan');assert.equal(db.donations(person).total,1);db.ingest(tip('after-restart','DifferentNick'));assert.equal(db.donations(person).total,2);
  const other=new StreamStore(path,'gulnaz');try{assert.equal(other.donorNicknames().length,0);assert.equal(other.persons().length,0);}finally{other.close();}
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});
