import test from 'node:test';
import assert from 'node:assert/strict';
import {decimalAmount,localDonationTime,donationTimestamp,normalizedDonationAmount} from './donation-form.ts';
test('donation form preserves exact large amounts and dates, and leaves unknown dates unknown',()=>{
 assert.equal(decimalAmount('1000000000000000000099'),'10000000000000000000.99');assert.equal(decimalAmount('50'),'0.50');assert.equal(decimalAmount('0'),'0.00');assert.equal(decimalAmount('bad'),'');
 const at=Date.UTC(2026,9,9,12,1,2),value=localDonationTime(at);assert.equal(donationTimestamp(value,at),at);assert.equal(donationTimestamp(value),at);
 assert.equal(localDonationTime(null),'');assert.equal(localDonationTime(NaN),'');assert.equal(donationTimestamp(''),null);
 for(const bad of ['bad','2026-02-30T12:00:00','2026-10-09T25:00:00','1969-12-31T00:00:00'])assert.throws(()=>donationTimestamp(bad));
});

test('Russian decimal comma and minute-only input stay exact without inventing unknown or invalid dates',()=>{
 assert.equal(normalizedDonationAmount(' 12,34 '),'12.34');assert.equal(normalizedDonationAmount('0.50'),'0.50');
 for(const bad of ['1e3','-1','1.234','01','1,2,3'])assert.throws(()=>normalizedDonationAmount(bad));
 const at=Date.UTC(2026,9,9,12),value=localDonationTime(at).slice(0,-3);assert.equal(donationTimestamp(value,at),at);assert.equal(donationTimestamp(value),at);
 assert.equal(donationTimestamp(localDonationTime(0),0),0);
 const far=Date.UTC(10000,0,1);assert.equal(donationTimestamp(localDonationTime(far)),far);
});

test('donation audit describes changed amount, recipient, source and message while preserving original values',async()=>{
 const {donationAuditChanges}=await import('./donation-form.ts');
 const before={amountMinor:'10000',currency:'RUB',personName:'Аноним',occurredAtMs:null,sourceName:'DonationAlerts',message:'Original'};
 const after={...before,amountMinor:'50',currency:'USD',personName:'Known donor',sourceName:'Cash',message:'Corrected'};
 const changes=donationAuditChanges(JSON.stringify(before),JSON.stringify(after));
 assert.deepEqual(changes.map(row=>row.label),['Сумма','Получатель','Источник','Сообщение']);
 assert.deepEqual(changes[0],{label:'Сумма',before:'100.00 RUB',after:'0.50 USD'});
 assert.equal(changes[1]!.before,'Аноним');assert.equal(changes[3]!.before,'Original');
 assert.equal(donationAuditChanges('null',JSON.stringify(after)).length,5);
 assert.deepEqual(donationAuditChanges(JSON.stringify(after),JSON.stringify(after)),[]);
});

test('donation audit formats missing fields and timestamp edits without inventing source values',async()=>{
 const {donationAuditChanges}=await import('./donation-form.ts');
 const changes=donationAuditChanges('null',JSON.stringify({amountMinor:'invalid',personName:null,occurredAtMs:'unknown',sourceName:null,message:null}));
 assert.deepEqual(changes.map(row=>row.after),['—','Аноним','Время неизвестно','','']);
 assert.ok(changes.every(row=>row.before===null));
 const original=Date.UTC(2026,0,2,3,4,5);
 const edited=localDonationTime(original).replace(/T\d{2}:\d{2}:\d{2}$/,'T03:05:05');
 assert.equal(donationTimestamp(edited,original),new Date(2026,0,2,3,5,5).getTime());
 assert.throws(()=>donationTimestamp('999999-12-31T23:59:59'),/корректные дату/);
});
