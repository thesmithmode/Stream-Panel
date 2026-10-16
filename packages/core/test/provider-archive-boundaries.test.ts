import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3';
import {migrateDatabase} from '../src/database-migrations.js';import {ProviderStorage} from '../src/provider-storage.js';
test('invalid archive imports cannot create pending donations or leak another account',()=>{
 const db=new Database(':memory:');try{migrateDatabase(db);const archive=new ProviderStorage(db);
 for(const [account,ids] of [['',['1']],['a',Array(2001).fill('1')],['a',['bad']]] as [string,string[]][])assert.throws(()=>archive.donationStates(account,ids),/INVALID_DONATION_IDS/);
 assert.throws(()=>archive.pending(''),/INVALID_DONATION_ACCOUNT/);assert.throws(()=>archive.pendingCount(''),/INVALID_DONATION_ACCOUNT/);
 for(const [account,raw] of [['','{}'],['a',null],['a',''],['a','{']] as [string,string|null][])assert.throws(()=>archive.saveFailure(account,raw as string,'BAD',1),/INVALID_PENDING_DONATION/);
 assert.equal(archive.pendingCount('a'),0);
 archive.saveFailure('a','null','not a safe code',1);archive.saveFailure('a','{"id":"12","amount":"1","currency":"RUB"}','BAD',2);
 assert.equal(archive.pendingCount('a'),2);assert.equal(archive.pendingCount('b'),0);
 archive.clearImported('b','12');assert.equal(archive.pendingCount('a'),2);archive.clearImported('a','12');assert.equal(archive.pendingCount('a'),1);
 const pending=archive.pending('a')[0]!;assert.equal(pending.serialized,'null');archive.removePending('a',pending.id);assert.equal(archive.pendingCount('a'),0);
 }finally{db.close();}
});
test('legacy notifications tolerate invalid nested JSON, absent history arrays and excessive nesting',()=>{
 const db=new Database(':memory:');try{migrateDatabase(db);const archive=new ProviderStorage(db);
 const save=db.prepare("INSERT INTO provider_snapshots VALUES (?,'donationalerts','legacy',?,1,NULL,?)");
 save.run('empty','donation_history_page',JSON.stringify({response:{data:{unexpected:true}}}));
 save.run('malformed','donation_notification',JSON.stringify({data:'{invalid'}));
 save.run('primitive','donation_notification','123');
 let nested:unknown={id:'99',amount:'1',currency:'RUB'};for(let i=0;i<8;i++)nested={data:nested};save.run('deep','donation_notification',JSON.stringify(nested));
 save.run('valid','donation_notification',JSON.stringify({publication:JSON.stringify({result:{id:'42',amount:'1',currency:'RUB'}})}));
 archive.migrate();assert.equal(archive.pendingCount('legacy'),1);assert.equal(JSON.parse(archive.pending('legacy')[0]!.serialized).id,'42');
 archive.migrate();assert.equal(archive.pendingCount('legacy'),1,'repeating recovery must not multiply unresolved money records');
 }finally{db.close();}
});
