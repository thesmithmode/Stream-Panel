import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';
import {rubMinor} from '../src/donation-fx.js';
import {eventKey} from '../src/domain.js';

test('historical CBR valuation preserves originals, handles nominal, Moscow midnight and rounding, and refreshes every total',()=>{
 const s=new StreamStore(':memory:'),at=Date.parse('2026-10-30T21:00:00Z');
 try{
  const sid=s.startSession('owner','fx',at-60000,'platform',at),person=String(s.createPerson('Donor').id);
  const input={personId:person,amount:'2.50',currency:'USD',occurredAtMs:at,message:'Original',sourceName:'Cash'};
  const usd=s.createDonation(input,at),kzt=s.createDonation({...input,amount:'1000',currency:'KZT'},at),rub=s.createDonation({...input,amount:'10',currency:'RUB'},at);
  assert.equal(usd.rubAmountMinor,null);assert.equal(s.channelOverview().pendingExchangeDonations,2);
  assert.deepEqual(s.pendingExchangeDates(at),['2026-10-31']);assert.equal(s.personsTop('donations')[0]!.donationCount,3);
  const stamp=s.changeStamp();
  s.saveExchangeRates('2026-10-31','2026-10-30',[{currency:'USD',value:'81.1234',nominal:1},{currency:'KZT',value:'16.5432',nominal:100}],at);
  assert.notEqual(s.changeStamp(),stamp);assert.deepEqual(s.pendingExchangeDates(at),[]);
  assert.equal(s.donation(usd.id).amountMinor,'250');assert.equal(s.donation(usd.id).currency,'USD');assert.equal(s.donation(usd.id).rubAmountMinor,'20281');assert.equal(s.donation(usd.id).exchangeRateDate,'2026-10-30');
  assert.equal(s.donation(kzt.id).rubAmountMinor,'16543');assert.equal(s.donation(rub.id).rubAmountMinor,'1000');
  const expected={RUB:'37824'};
  assert.deepEqual(s.summary(sid).totals,expected);assert.deepEqual(s.channelOverview().totals,expected);assert.equal(s.channelOverview().pendingExchangeDonations,0);
  assert.deepEqual(s.personStats(person).donationTotals,expected);assert.deepEqual(s.personsTop('donations',sid)[0]!.donationTotals,expected);assert.deepEqual(s.sessions(sid)[0]!.donationTotals,expected);
  assert.equal(s.donations().items.find(x=>x.id===usd.id)!.rubAmountMinor,'20281');
  // Re-fetching never changes a stored historical rate.
  const stable=s.changeStamp();s.saveExchangeRates('2026-10-31','2026-10-30',[{currency:'USD',value:'99.0000',nominal:1}],at);assert.equal(s.changeStamp(),stable);assert.equal(s.donation(usd.id).rubAmountMinor,'20281');
  s.updateDonation(usd.id,{...input,occurredAtMs:at-1},0,at);assert.equal(s.donation(usd.id).rubAmountMinor,null);
  s.saveExchangeRates('2026-10-30','2026-10-29',[{currency:'USD',value:'80.0000',nominal:1}],at);assert.equal(s.donation(usd.id).rubAmountMinor,'20000');
  s.deleteDonation(usd.id,1,at);assert.deepEqual(s.channelOverview().totals,{RUB:'17543'});s.restoreDonation(usd.id,2,at);assert.deepEqual(s.channelOverview().totals,{RUB:'37543'});
  const unknown={source:'donationalerts' as const,accountId:'da',externalId:'unknown',type:'donation',actor:null,occurredAtMs:null,receivedAtMs:at,sourceTime:null,timeQuality:'unknown' as const,transport:'rest' as const,payload:{currency:'EUR',amountMinor:'100'}};s.ingest(unknown);
  assert.equal(s.donation(eventKey(unknown)).rubAmountMinor,null);assert.equal(s.channelOverview().pendingExchangeDonations,1);assert.deepEqual(s.pendingExchangeDates(at),[]);
  s.createDonation({...input,currency:'TRY'},at);assert.deepEqual(s.pendingExchangeDates(at),[]);assert.deepEqual(s.pendingExchangeDates(at+86400000),['2026-10-31']);
  for(const [day,effective,rates] of [['bad','2026-10-30',[]],['2026-10-30','bad',[]],['2026-10-30','2026-10-31',[]],['2026-10-30','2026-10-30',[]],['2026-10-30','2026-10-30',[{currency:'bad',value:'1.0000',nominal:1}]],['2026-10-30','2026-10-30',[{currency:'USD',value:'bad',nominal:1}]]] as const)assert.throws(()=>s.saveExchangeRates(day,effective,[...rates],at),/INVALID_CBR_RATES/);
 }finally{s.close();}
});
test('exact money conversion rejects missing/malformed inputs and retains large integer precision',()=>{
 for(const args of [[null,'1.0000',1],['-1','1.0000',1],['1',null,1],['1','bad',1],['1','1.0000',null],['1','1.0000',1.5],['1','1.0000',0],['1','0.0000',1]] as const)assert.equal(rubMinor(args[0],args[1],args[2]),null);
 assert.equal(rubMinor('1','0.5000',1),'1');assert.equal(rubMinor('1','0.4900',1),'0');assert.equal(rubMinor('900719925474099301','100.0000',1),'90071992547409930100');
});
test('CBR rates persist and remain isolated between profiles and after reopening',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-fx-')),path=join(dir,'db');let a=new StreamStore(path,'ruslan');const b=new StreamStore(path,'gulnaz'),at=Date.parse('2026-10-31T12:00:00Z');
 try{
  const input={amount:'1',currency:'USD',occurredAtMs:at,message:'',sourceName:'Cash'};
  const tip=a.createDonation({...input,personId:String(a.createPerson('A').id)},at);b.createDonation({...input,personId:String(b.createPerson('B').id)},at);
  a.saveExchangeRates('2026-10-31','2026-10-30',[{currency:'USD',value:'80.0000',nominal:1}],at);a.close();a=new StreamStore(path,'ruslan');
  assert.equal(a.donation(tip.id).rubAmountMinor,'8000');assert.equal(b.channelOverview().pendingExchangeDonations,1);assert.deepEqual(b.pendingExchangeDates(at),['2026-10-31']);
 }finally{a.close();b.close();await rm(dir,{recursive:true,force:true});}
});

test('recent event text preserves the original currency and uses confirmed event dates for CBR',()=>{
 const s=new StreamStore(':memory:'),at=Date.now()-1000,day=new Date(at+10800000).toISOString().slice(0,10);
 try{
  const tip={source:'donationalerts' as const,accountId:'da',externalId:'recent',type:'donation',actor:null,occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider' as const,transport:'rest' as const,payload:{currency:'USD',amountMinor:'100',text:'Original'}};
  s.ingest(tip);s.ingest({...tip,externalId:'unknown',occurredAtMs:null,timeQuality:'unknown'});
  s.saveExchangeRates(day,day,[{currency:'USD',value:'80.0000',nominal:1}],at);
  const rows=s.recentEvents();assert.equal(rows.find(r=>r.external_id==='recent')!.payload.rubAmountMinor,'8000');assert.equal(rows.find(r=>r.external_id==='recent')!.payload.currency,'USD');assert.equal(rows.find(r=>r.external_id==='unknown')!.payload.rubAmountMinor,null);
 }finally{s.close();}
});
