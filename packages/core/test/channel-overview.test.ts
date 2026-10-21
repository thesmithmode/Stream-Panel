import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
test('all-history overview has compact real totals and excludes breaks, deleted streams and bot participants',()=>{
 const s=new StreamStore(':memory:');try{
 const at=Date.now()-7200000,id=s.startSession('owner','one',at,'platform',at);
 s.ingest({source:'twitch',accountId:'owner',externalId:'msg',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:at+60000,receivedAtMs:at+60000,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hi'}});
 s.recordPoll(id,'owner',{startedAtMs:at,completedAtMs:at+60000,status:'complete',userIds:['viewer','silent','bot'],userNames:{bot:'jeetbot'}});s.endSession(id,at+3600000);
 const data=s.channelOverview();assert.equal(data.streams,1);assert.equal(data.durationMinutes,60);assert.equal(data.messages,1);const compact=s.summary(id,[],false);assert.equal(compact.messages,1);assert.equal('chattersOverTime' in compact,false);assert.equal(data.attendees,2);assert.deepEqual(data.totals,{});assert.equal('timeline' in data,false);
 }finally{s.close();}
});


test('overview donation window uses exact timestamps, corrections and separate currencies',()=>{
 const s=new StreamStore(':memory:');const now=Date.now,at=Date.parse('2026-10-21T12:00:00Z');Date.now=()=>at;
 try{
  const day=86400000;
  for(const [id,time,currency,amount,name] of [
   ['boundary',at-30*day,'RUB','100','Viewer'],['old',at-30*day-1,'RUB','200','Viewer'],
   ['recent',at-1,'EUR','300','Viewer'],['future',at,'RUB','400','Viewer'],
   ['unknown',null,'RUB','500','Viewer'],['bot',at-1000,'RUB','600','jeetbot']
  ] as const)s.ingest({source:'donationalerts',accountId:'donations',externalId:id,type:'donation',actor:{externalId:`name:${name.toLowerCase()}`,displayName:name},occurredAtMs:time,receivedAtMs:at,sourceTime:null,timeQuality:time===null?'unknown':'provider',transport:'rest',payload:{currency,amountMinor:amount}});
  const data=s.channelOverview();assert.deepEqual(data.totals30,{EUR:'300',RUB:'100'});assert.deepEqual(data.totals,{RUB:'1200',EUR:'300'});
  assert.equal('hours' in data,false);
  const person=s.persons().find(p=>p.display_name==='Viewer')!;
  const input={personId:String(person.id),amount:'4.00',currency:'RUB',occurredAtMs:at-1000,message:'',sourceName:'Manual'};
  const donation=s.createDonation(input,at);assert.equal(s.channelOverview().totals30.RUB,'500');
  const corrected=s.updateDonation(String(donation.id),{...input,occurredAtMs:at-31*day},Number(donation.revision),at);
  assert.equal(s.channelOverview().totals30.RUB,'100');s.deleteDonation(String(corrected.id),Number(corrected.revision),at);assert.deepEqual(s.channelOverview().totals,data.totals);
 }finally{Date.now=now;s.close();}
});
