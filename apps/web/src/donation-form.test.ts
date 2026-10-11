import test from 'node:test';
import assert from 'node:assert/strict';
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
});
