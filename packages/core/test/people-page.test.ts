import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';

test('people pages expose every person with stable ordering and remove bots before pagination',()=>{
 const store=new StreamStore(':memory:');
 try{
  for(let i=0;i<501;i++)store.createPerson(`Viewer ${String(i).padStart(3,'0')}`);
  for(const name of ['nightbot','frankie_showman','custom-bot'])store.ingest({source:'twitch',accountId:'owner',externalId:name,type:'chat.message',actor:{externalId:name,displayName:name},occurredAtMs:1000,receivedAtMs:1000,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{count:1}});
  const ids=new Set();
  for(let offset=0;offset<=500;offset+=50){
   const page=store.personsPage('',['custom-bot'],0,offset,50);
   assert.equal(page.total,501);assert.equal(page.items.length,offset===500?1:50);
   for(const person of page.items){assert.equal(person.is_bot,0);assert.equal(ids.has(person.id),false);ids.add(person.id);assert.equal('_total' in person,false);}
  }
  assert.equal(ids.size,501);
  const search=store.personsPage('Viewer 500',['custom-bot']);assert.equal(search.total,1);assert.equal(search.items[0]!.display_name,'Viewer 500');
  const beyond=store.personsPage('',['custom-bot'],0,550);assert.equal(beyond.total,501);assert.deepEqual(beyond.items,[]);
  assert.equal(store.personsPage('missing').total,0);
  assert.throws(()=>store.personsPage('',[],0,-1),/INVALID_PERSON_PAGE/);
  assert.throws(()=>store.personsPage('',[],0,0,101),/INVALID_PERSON_PAGE/);
  assert.throws(()=>store.personsPage('',[],-1),/INVALID_PERIOD/);
 }finally{store.close();}
});

test('following existence checks do not load event history',()=>{
 const store=new StreamStore(':memory:');
 try{
  const id=String(store.createPerson('Viewer').id);
  (store as any).queries.events=()=>{throw Error('UNEXPECTED_EVENT_HISTORY_READ');};
  assert.deepEqual(store.personFollowing(id),[]);
  assert.throws(()=>store.personFollowing('missing'),/PERSON_NOT_FOUND/);
 }finally{store.close();}
});
