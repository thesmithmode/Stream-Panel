import test from 'node:test';import assert from 'node:assert/strict';import {StreamStore} from '../src/store.js';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const stats=(s:StreamStore,id:string)=>s.personStats(id) as {donationTotals:Record<string,string>;donationCount:number};
const now=Date.UTC(2026,9,13,10),day=86400000;
function tip(s:StreamStore,id:string,name:string,amount:string,at:number|null,account='da'){return s.ingest({source:'donationalerts',accountId:account,externalId:id,type:'donation',actor:{externalId:`name:${name.toLowerCase()}`,displayName:name},occurredAtMs:at,receivedAtMs:now,sourceTime:null,timeQuality:at===null?'unknown':'provider',transport:'rest',payload:{amountMinor:amount,currency:'RUB'}});}
test('donor ranking uses exact total money before limiting, applies date windows, corrections, deletion and keeps untimed donations only for all time',()=>{const s=new StreamStore(':memory:');try{
 const a=tip(s,'a','Large','90071992547409931234',now-day),b=tip(s,'b','Small','100',now-day);for(let i=0;i<5;i++)tip(s,`s-${i}`,'Small','100',now-day);tip(s,'old','Old','200000',now-20*day);tip(s,'unknown','Unknown','200',null);
 const top=s.personsTop('donations',undefined,[],1);assert.equal(top[0]!.id,a.personId);assert.equal((top[0]!.donationTotals as any).RUB,'90071992547409931234');
 const recent=s.personsTop('donations',undefined,[],50,now-7*day,now);assert.equal(recent.length,2);assert.ok(!recent.some(p=>p.display_name==='Unknown'));assert.equal(s.personsTop('donations',undefined,[],50,now-30*day,now).length,3);
 const donation=s.donations(a.personId!).items[0]!;s.reassignDonation(String(donation.id),b.personId!,0,now);assert.equal(s.personsTop('donations')[0]!.id,b.personId);
 const corrected=s.donation(String(donation.id));s.deleteDonation(String(donation.id),Number(corrected.revision),now);assert.equal(s.personsTop('donations')[0]!.display_name,'Old');
 const analytics=s.analytics({fromMs:0,toMs:now+1});assert.equal(analytics.donationTiming.unknownCount,1);assert.equal(analytics.donationTiming.count,8);assert.ok(analytics.donationTiming.hours.length>0);assert.equal(analytics.summary.messages,0);
 assert.throws(()=>s.personsTop('donations',undefined,[],50,now,now),/INVALID_DONATION_WINDOW/);assert.throws(()=>s.personsTop('donations',undefined,[],50,undefined,undefined,'bad'),/INVALID_CURRENCY/);
}finally{s.close();}});
test('same donor nick and provider event IDs remain independent across profiles, bindings, individual corrections and restart',async()=>{const dir=await mkdtemp(join(tmpdir(),'sp-donor-profile-')),path=join(dir,'db.sqlite');let a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz');try{
 const viewer=(s:StreamStore)=>s.ingest({source:'twitch',accountId:'channel',externalId:'chat',type:'chat.message',actor:{externalId:'chikist',displayName:'chikist007'},occurredAtMs:now,receivedAtMs:now,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}}).personId!;
 const pa=viewer(a),pb=viewer(b);tip(a,'same','egor4ik','10000',now);tip(b,'same','egor4ik','22800',now);
 // The nickname link is shared by profiles (same Twitch account); each profile keeps its own money.
 a.bindDonorNickname(pa,'egor4ik',a.personRevision(pa),now);assert.equal(stats(a,pa).donationTotals.RUB,'10000');assert.equal(stats(b,pb).donationTotals.RUB,'22800');assert.equal(b.donorBindings(pb).length,1);assert.equal((b.summary().totals as Record<string,string>).RUB,'22800');
 b.bindDonorNickname(pb,'egor4ik',b.personRevision(pb),now);assert.equal(stats(b,pb).donationTotals.RUB,'22800');assert.equal(stats(a,pa).donationTotals.RUB,'10000');
 const row=b.donations(pb).items[0]!;b.reassignDonation(String(row.id),null,0,now);assert.equal(stats(b,pb).donationCount,0);assert.equal(stats(a,pa).donationCount,1);
 tip(a,'next','egor4ik','300',now);tip(b,'next','egor4ik','400',now);assert.equal(stats(a,pa).donationTotals.RUB,'10300');assert.equal(stats(b,pb).donationTotals.RUB,'400');
 assert.throws(()=>b.bindDonorNickname(pa,'other',0,now),/PERSON_NOT_FOUND/);a.close();b.close();a=new StreamStore(path,'ruslan');b=new StreamStore(path,'gulnaz');assert.equal(stats(a,pa).donationTotals.RUB,'10300');assert.equal(stats(b,pb).donationTotals.RUB,'400');
}finally{a.close();b.close();await rm(dir,{recursive:true,force:true});}});
