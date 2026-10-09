import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';
import {schemaV1,schemaV2,schemaV3,schemaV4,schemaV5,schemaV6} from '../src/schema.js';

function makeV6(path:string) {
 const db=new Database(path);
 db.exec(`${schemaV1}\n${schemaV2}\n${schemaV3}\n${schemaV4}\n${schemaV5}\n${schemaV6}`);
 db.prepare('INSERT INTO persons(id,display_name) VALUES (?,?)').run('person-1','Viewer');
 db.close();
}

test('v6 upgrade adds person metadata tables and preserves data across reopen',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-person-metadata-v6-'));
 const path=join(dir,'data.sqlite');
 try {
  makeV6(path);
  const store=new StreamStore(path);
  store.close();
  let db=new Database(path);
  try {
   db.pragma('foreign_keys=ON');
   assert.equal(db.pragma('user_version',{simple:true}),7);
   db.prepare('INSERT INTO person_notes(id,person_id,body,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?)').run('note-1','person-1','A note',10,11);
   db.prepare('INSERT INTO person_tags(person_id,label) VALUES (?,?)').run('person-1','regular');
   db.prepare('INSERT INTO person_preferences(person_id,manual_core) VALUES (?,?)').run('person-1',1);
   assert.equal((db.prepare('SELECT revision FROM person_notes WHERE id=?').get('note-1') as {revision:number}).revision,0);
   assert.equal((db.prepare('SELECT body FROM person_notes WHERE id=?').get('note-1') as {body:string}).body,'A note');
   assert.equal((db.prepare('SELECT label FROM person_tags WHERE person_id=?').get('person-1') as {label:string}).label,'regular');
   assert.equal((db.prepare('SELECT manual_core FROM person_preferences WHERE person_id=?').get('person-1') as {manual_core:number}).manual_core,1);
   assert.throws(()=>db.prepare('INSERT INTO person_preferences(person_id,manual_core) VALUES (?,?)').run('person-1',2));
   assert.throws(()=>db.prepare('INSERT INTO person_tags(person_id,label) VALUES (?,?)').run('person-1','regular'));
   assert.throws(()=>db.prepare('INSERT INTO person_notes(id,person_id,body,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?)').run('orphan','missing','x',1,1));
   assert.equal((db.prepare("SELECT wr FROM pragma_table_list WHERE name='person_tags'").get() as {wr:number}).wr,1);
   assert.equal((db.prepare("SELECT count(*) AS n FROM pragma_index_list('person_notes') WHERE name='person_notes_person_created'").get() as {n:number}).n,1);
   assert.equal((db.pragma('foreign_key_check') as unknown[]).length,0);
  } finally {db.close();}
  const reopened=new StreamStore(path);reopened.close();
  db=new Database(path);
  try {assert.equal((db.prepare('SELECT body FROM person_notes WHERE id=?').get('note-1') as {body:string}).body,'A note');} finally {db.close();}
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('person metadata migrations and records are isolated per profile',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-person-metadata-profile-'));
 const path=join(dir,'data.sqlite');
 try {
  makeV6(path);
  for(const profile of ['ruslan','gulnaz']) {
   const store=new StreamStore(path,profile);
   store.close();
  }
  const db=new Database(path);
  try {
   db.pragma('foreign_keys=ON');
   assert.deepEqual(db.prepare('SELECT profile,version FROM sp_profile_schema ORDER BY profile').all(),[
    {profile:'gulnaz',version:7},{profile:'ruslan',version:7},
   ]);
   for(const profile of ['ruslan','gulnaz']) {
    db.prepare(`INSERT INTO p_${profile}_persons(id,display_name) VALUES (?,?)`).run('person-1',profile);
    db.prepare(`INSERT INTO p_${profile}_person_notes(id,person_id,body,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?)`).run(`${profile}-note`,'person-1',profile,1,2);
    db.prepare(`INSERT INTO p_${profile}_person_tags(person_id,label) VALUES (?,?)`).run('person-1',profile);
    assert.equal((db.prepare(`SELECT body FROM p_${profile}_person_notes WHERE id=?`).get(`${profile}-note`) as {body:string}).body,profile);
    assert.equal((db.prepare(`PRAGMA foreign_key_check(p_${profile}_person_notes)`).all()).length,0);
   }
   assert.equal((db.prepare('SELECT count(*) AS n FROM p_ruslan_person_notes').get() as {n:number}).n,1);
   assert.equal((db.prepare('SELECT count(*) AS n FROM p_gulnaz_person_notes').get() as {n:number}).n,1);
   assert.equal((db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='person_notes'").get() as {n:number}).n,0);
  } finally {db.close();}
 } finally {await rm(dir,{recursive:true,force:true});}
});
