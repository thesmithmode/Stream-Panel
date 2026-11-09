import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('all-time maximum uses exact RUB amounts, corrections, deletion, rates and independent profiles',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-max-tip-')),path=join(dir,'db');
 const a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz');
 try{
  const at=Date.parse('2026-10-31T12:00:00Z'),personId=String(a.createPerson('Donor').id);
  assert.equal(a.channelOverview().maximumDonation,null);
  const input={personId,amount:'9',currency:'RUB',occurredAtMs:at,message:'',sourceName:'Cash'};
  const small=a.createDonation(input,at),large=a.createDonation({...input,amount:'10000000000000000000.99'},at);
  assert.equal(a.channelOverview().maximumDonation?.id,large.id);
  assert.equal(a.channelOverview().maximumDonation?.amount,'1000000000000000000099');
  assert.equal(b.channelOverview().maximumDonation,null);
  a.deleteDonation(large.id,0,at);assert.equal(a.channelOverview().maximumDonation?.id,small.id);
  a.updateDonation(small.id,{...input,amount:'1'},0,at);assert.equal(a.channelOverview().maximumDonation?.amount,'100');
  const usd=a.createDonation({...input,currency:'USD',amount:'2'},at);
  assert.equal(a.channelOverview().maximumDonation?.id,small.id);
  a.saveExchangeRates('2026-10-31','2026-10-30',[{currency:'USD',value:'80.0000',nominal:1}],at);
  assert.equal(a.channelOverview().maximumDonation?.id,usd.id);assert.equal(a.channelOverview().maximumDonation?.amount,'16000');
  assert.equal(a.channelOverview().maximumDonation?.name,'Donor');
  a.updateDonation(usd.id,{...input,amount:'300',occurredAtMs:null},0,at);
  assert.equal(a.channelOverview().maximumDonation?.at,null);
  a.restoreDonation(large.id,1,at);assert.equal(a.channelOverview().maximumDonation?.id,large.id);
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
