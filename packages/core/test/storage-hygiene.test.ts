import test from 'node:test';import assert from 'node:assert/strict';import {StreamStore} from '../src/store.js';
test('successful diagnostics are discarded while follower evidence is minimal and failed imports do not multiply',()=>{
 const s=new StreamStore(':memory:');try{
  for(let i=0;i<100;i++)for(const key of ['chatters','api:/helix/chat/chatters','stream','donation_history_page','donation_notification'])s.providerSnapshot('twitch','owner',key,{future:'unused'},1000+i);
  const db=(s as any).db;assert.equal(db.prepare('SELECT count(*) AS n FROM provider_snapshots').get().n,0);
  for(let i=0;i<5;i++)s.followingSnapshot('twitch','owner',[{id:'viewer',name:'Viewer',followedAtMs:10,raw:{unused:'discard'}}],true,1200+i);
  const rows=db.prepare('SELECT payload_json FROM provider_snapshots').all();assert.equal(rows.length,5);assert.ok(rows.every((row:any)=>!row.payload_json.includes('unused')));
  for(let i=0;i<100;i++)s.saveDonationImportFailure('owner','{"id":"1","amount":"bad"}','INVALID_AMOUNT',1300+i);
  assert.equal(s.pendingDonationImports('owner').length,1);assert.equal(s.pendingDonationImportCount('owner'),1);
 }finally{s.close();}
});
