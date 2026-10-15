import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {AudienceQueries} from '../src/audience-queries.js';
import {migrateDatabase} from '../src/database-migrations.js';
import {openProfileDatabase} from '../src/profile-db.js';

const at=Date.UTC(2026,9,15,12);
function fixture(profile?:string){
 const db=profile?openProfileDatabase(':memory:',profile):new Database(':memory:');
 migrateDatabase(db);
 for(const id of ['first','second','anonymous']){
  db.prepare('INSERT INTO persons VALUES (?,?,0)').run(id,id);
  db.prepare("INSERT INTO identities VALUES (?,'donationalerts','channel',?,?,?, ?,?)").run(id,id,id,id,id,id);
 }
 const queries=new AudienceQueries(db);
 const event=(id:string,identity:string|null,occurred:number|null=at,type='chat.message',source='twitch')=>{
  db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,source,'channel',id,type,identity,occurred,occurred??at+100,null,occurred===null?'unknown':'provider','rest','{}');
 };
 return {db,queries,event};
}

test('person feed uses effective donation identity, deletion and legacy anonymous fallback',()=>{
 const {db,queries,event}=fixture();try{
  event('regular','first');event('reassigned','first',at,'donation','donationalerts');
  event('legacy',null,at,'donation','donationalerts');
  db.prepare('INSERT INTO anonymous_donors VALUES (?,?)').run('channel','anonymous');
  db.prepare("INSERT INTO donation_corrections VALUES ('reassigned','second',?, '{}',0,1,?)").run(at+1,at+1);
  assert.deepEqual(queries.events(undefined,'first').map(e=>e.id),['regular']);
  assert.deepEqual(queries.events(undefined,'second').map(e=>e.id),['reassigned']);
  assert.deepEqual(queries.events(undefined,'anonymous').map(e=>e.id),['legacy']);
  db.prepare("UPDATE donation_corrections SET deleted=1 WHERE event_id='reassigned'").run();
  assert.equal(queries.events(undefined,'second').length,0);
  db.prepare("UPDATE donation_corrections SET deleted=0,identity_id=NULL WHERE event_id='reassigned'").run();
  assert.deepEqual(queries.events(undefined,'first').map(e=>e.id),['reassigned','regular']);
 }finally{db.close();}
});

test('person feed reflects current identity membership and preserves time, type, source and session filters',()=>{
 const {db,queries,event}=fixture();try{
  event('known','first');event('unknown','first',null);event('tip','first',at+1,'donation','donationalerts');
  db.prepare("INSERT INTO sessions VALUES ('session','channel','stream','platform',?,?,NULL,'unknown')").run(at,at);
  db.prepare("INSERT INTO event_sessions VALUES ('known','session')").run();
  assert.deepEqual(queries.events(undefined,'first').map(e=>e.id),['unknown','tip','known']);
  assert.deepEqual(queries.events('session','first').map(e=>e.id),['known']);
  assert.deepEqual(queries.events(undefined,'first',at,at+1).map(e=>e.id),['known']);
  assert.deepEqual(queries.events(undefined,'first',undefined,undefined,'donation').map(e=>e.id),['tip']);
  assert.deepEqual(queries.events(undefined,'first',undefined,undefined,undefined,'twitch').map(e=>e.id),['unknown','known']);
  assert.deepEqual(queries.events(undefined,'first',undefined,undefined,undefined,'youtube'),[]);
  db.prepare("UPDATE identities SET person_id='second' WHERE id='first'").run();
  assert.equal(queries.events(undefined,'first').length,0);
  assert.equal(queries.events(undefined,'second').length,3);
  db.prepare("UPDATE identities SET person_id='first' WHERE id='first'").run();
  assert.equal(queries.events(undefined,'first').length,3);
  assert.equal(queries.events(undefined,'second').length,0);
 }finally{db.close();}
});

test('indexed person feed preserves the existing 200 item cap and profile table rewriting',()=>{
 const {db,queries,event}=fixture('ruslan');try{
  db.transaction(()=>{for(let n=0;n<220;n++)event(`event:${n}`,'first',at+n);})();
  const rows=queries.events(undefined,'first');
  assert.equal(rows.length,200);assert.equal(rows[0]!.id,'event:219');assert.equal(rows[199]!.id,'event:20');
  assert.equal(queries.events(undefined,'missing').length,0);
  assert.equal(queries.events().length,200);
 }finally{db.close();}
});
