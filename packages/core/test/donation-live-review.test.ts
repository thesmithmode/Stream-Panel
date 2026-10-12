import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
import {eventKey,type EventInput} from '../src/domain.js';
const at=Date.now();
const tip=(id:string,time:number|null=at):EventInput=>({source:'donationalerts',accountId:'da',externalId:id,type:'donation',actor:{externalId:'name:donor',displayName:'Donor'},occurredAtMs:time,receivedAtMs:at,sourceTime:'2026-10-12 12:00:00',timeQuality:time===null?'unknown':'configured',transport:'centrifugo',payload:{actorName:'Donor',amountMinor:'22800',currency:'RUB'}});
test('untimed realtime donation belongs to the confirmed live stream and survives reassignment and history deduplication',()=>{
 const s=new StreamStore(':memory:');try{const sid=s.startSession('owner','live',at-60000,'platform',at-60000),e=tip('live',null);
 s.ingestLiveDonation(e,sid,true);assert.equal(s.summary(sid).donations,1);assert.deepEqual(s.summary(sid).totals,{RUB:'22800'});assert.equal(s.donation(eventKey(e)).occurredAtMs,null);
 const person=String(s.createPerson('Viewer').id);s.reassignDonation(eventKey(e),person,0,at);s.ingest({...e,transport:'rest'});assert.equal(s.summary(sid).donations,1);s.endSession(sid,at+1000);assert.equal(s.summary(sid).donations,1);
 }finally{s.close();}
});
test('history can resolve previously unknown donation time without duplicating money or overwriting manual assignment',()=>{
 const s=new StreamStore(':memory:');try{const sid=s.startSession('owner','live',at-60000,'platform',at-60000),e=tip('history',null);s.ingest({...e,transport:'rest'});assert.equal(s.summary(sid).donations,0);
 const person=String(s.createPerson('Chosen').id);s.reassignDonation(eventKey(e),person,0,at);s.ingest({...e,occurredAtMs:at,timeQuality:'configured',transport:'rest'});assert.equal(s.summary(sid).donations,1);assert.equal(s.donation(eventKey(e)).personId,person);assert.equal(s.summary().donations,1);
 }finally{s.close();}
});
test('stream donation pagination includes donations older than the last 200 chat events; suggestions use only messages within two minutes',()=>{
 const s=new StreamStore(':memory:');try{const sid=s.startSession('owner','live',at-600000,'platform',at-600000),e=tip('past',at-300000);s.ingest(e);
 for(let i=0;i<205;i++)s.ingest({source:'twitch',accountId:'owner',externalId:String(i),type:'chat.message',actor:{externalId:'later',displayName:'Later'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}});
 const near=s.ingest({source:'twitch',accountId:'owner',externalId:'near',type:'chat.message',actor:{externalId:'near',displayName:'Near'},occurredAtMs:at-420000,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'near'}}).personId;
 assert.equal(s.donations(undefined,0,10,false,sid).items[0]?.id,eventKey(e));assert.equal(s.donations(undefined,0,10,false,sid).total,1);
 assert.deepEqual(s.donationCandidates(eventKey(e)).map(p=>p.id),[near]);assert.throws(()=>s.donationCandidates(eventKey(tip('missing'))),/DONATION_NOT_FOUND/);
 }finally{s.close();}
});
test('read query count remains bounded as streams and donation pages grow',()=>{
 const s=new StreamStore(':memory:');try{
 const person=s.ingest({source:'twitch',accountId:'owner',externalId:'viewer-first',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}}).personId!;
 const make=(n:number)=>{const start=at+n*120000,id=s.startSession('owner',String(n),start,'platform',start);s.recordPoll(id,'owner',{startedAtMs:start,completedAtMs:start+60000,status:'complete',userIds:['viewer']});s.endSession(id,start+120000);};
 make(0);
 const db=(s as unknown as {db:{prepare:(...args:unknown[])=>unknown}}).db,prepare=db.prepare.bind(db);let queries=0;db.prepare=(...args)=>{queries++;return prepare(...args);};
 s.personStats(person);const small=queries;
 for(let i=1;i<101;i++)make(i);queries=0;s.personStats(person);assert.equal(queries,small,'opening a person must not add SQL round trips for each historical stream');
 queries=0;s.sessions();assert.ok(queries<=6,'stream cards use batch reads');
 for(let i=0;i<20;i++)s.ingest(tip('page'+i));queries=0;s.donations();assert.equal(queries,2,'donations require a page and a count, not a query per row');
 queries=0;s.personsTop('observed_minutes');assert.ok(queries<=6,'ranking must not query each viewer/stream combination');
 }finally{s.close();}
});
test('reimport preserves an explicitly cleared correction time; reassignment of a deleted timed donation restores its stream',()=>{
 const s=new StreamStore(':memory:');try{const sid=s.startSession('owner','live',at-60000,'platform',at-60000),e=tip('correction',null),person=s.ingest(e).personId!;
 s.updateDonation(eventKey(e),{personId:person,amount:'228',currency:'RUB',occurredAtMs:null,message:'corrected',sourceName:'DonationAlerts'},0,at);
 s.ingest({...e,occurredAtMs:at,timeQuality:'configured',transport:'rest'});assert.equal(s.donation(eventKey(e)).occurredAtMs,null);assert.equal(s.summary(sid).donations,0);
 const known=tip('deleted');s.ingest(known);s.deleteDonation(eventKey(known),0,at);s.reassignDonation(eventKey(known),person,1,at);assert.equal(s.summary(sid).donations,1);assert.equal(s.donation(eventKey(known)).deleted,false);
 }finally{s.close();}
});
