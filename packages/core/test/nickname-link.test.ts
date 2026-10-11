import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
import {eventKey,daDonorExternalId} from '../src/domain.js';
const at=Date.UTC(2026,9,11,12);
const tip=(id:string,name='Chekist007')=>({source:'donationalerts' as const,accountId:'da',externalId:id,type:'donation',actor:{externalId:daDonorExternalId(name),displayName:name},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider' as const,transport:'rest' as const,payload:{actorName:name,amountMinor:'10000',currency:'RUB',text:'Original'}});
test('presence-only viewers link to an existing same-name donor, including later name resolution',()=>{
 const s=new StreamStore(':memory:');try{
  const donor=s.ingest(tip('one')).personId!;const session=s.startSession('channel','stream',at,'platform',at);
  s.recordPoll(session,'channel',{startedAtMs:at,completedAtMs:at,status:'complete',userIds:['42'],userNames:{'42':'chekist007'}});
  assert.equal(s.persons().filter(p=>p.display_name==='Chekist007'||p.display_name==='chekist007').length,1);
  assert.equal(s.personStats(donor).totalObservedMinutes,1);
  const second=s.ingest(tip('two','LaterName')).personId!;
  s.recordPoll(session,'channel',{startedAtMs:at,completedAtMs:at,status:'complete',userIds:['43']});
  s.updateChatterNames('channel',[{user_id:'43',user_name:'LaterName'}],at+1);
  const active=s.persons().find(p=>p.display_name==='LaterName')!;assert.equal(s.personStats(String(active.id)).totalObservedMinutes,1);assert.equal(s.personStats(String(active.id)).donationCount,1);assert.ok(second);
 }finally{s.close();}
});
test('YouTube, Twitch and DA exact nicknames share one person; repeat import preserves single assignment',()=>{
 const s=new StreamStore(':memory:');try{
  const e=tip('one'),donor=s.ingest(e).personId!;
  s.youtubeMessages('yt','chat',[{id:'yt-message',snippet:{type:'textMessageEvent',publishedAt:new Date(at).toISOString()},authorDetails:{channelId:'yt-viewer',displayName:'Chekist007'}}]);
  assert.equal(s.persons().length,1);assert.equal(s.person(donor).identities instanceof Array,true);
  const other=s.ingest(tip('other','Other')).personId!;
  const original=s.donation(eventKey(e));
  const reassigned=s.reassignDonation(original.id,other,original.revision,at+1);
  for(let i=0;i<3;i++)s.ingest(e);
  assert.equal(s.donation(original.id).personId,other);assert.equal(s.donation(original.id).originalActorName,'Chekist007');
  assert.equal(s.donation(original.id).message,'Original');assert.equal(s.donation(original.id).amountMinor,'10000');
  assert.equal(s.donations().total,2);assert.equal(reassigned.revision,1);
  s.reassignDonation(original.id,null,1,at+2);
  assert.equal(s.donation(original.id).personName,'Аноним');assert.equal(s.donations().total,2);
 }finally{s.close();}
});
