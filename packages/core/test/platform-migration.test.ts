import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';
import {schemaV1,schemaV2,schemaV3,schemaV4,schemaV5} from '../src/schema.js';

test('v5 migration preserves stream history and seeds one Twitch ledger row per platform session',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-platform-migration-'));
 const path=join(dir,'data.sqlite');
 const platformId='platform-session';
 const legacy=new Database(path);
 legacy.exec(`${schemaV1}\n${schemaV2}\n${schemaV3}\n${schemaV4}\n${schemaV5}`);
 legacy.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)').run(platformId,'account','external-1','platform',1000,1100,1400,'unknown');
 legacy.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)').run('manual-session','account','manual-1','manual',2000,2100,null,'unknown');
 legacy.prepare('INSERT INTO stream_samples VALUES (?,?,?,?,?,?,?)').run(platformId,1200,'cat-1','Category 1','First title',5,null);
 legacy.prepare('INSERT INTO stream_samples VALUES (?,?,?,?,?,?,?)').run(platformId,1300,'cat-2','Category 2','Latest title',8,null);
 legacy.prepare('INSERT INTO stream_samples VALUES (?,?,?,?,?,?,?)').run('manual-session',2200,'','','Manual sample',null,null);
 const sessionsBefore=legacy.prepare('SELECT * FROM sessions ORDER BY id').all();
 const samplesBefore=legacy.prepare('SELECT * FROM stream_samples ORDER BY session_id,observed_at_ms').all();
 legacy.close();

 try {
  const migrated=new StreamStore(path);
  migrated.close();
  const db=new Database(path);
  try {
   assert.deepEqual(db.prepare('SELECT * FROM sessions ORDER BY id').all(),sessionsBefore);
   assert.deepEqual(db.prepare('SELECT * FROM stream_samples ORDER BY session_id,observed_at_ms').all(),samplesBefore);
   const rows=db.prepare('SELECT * FROM platform_streams').all() as {platform:string;account_id:string;external_id:string;session_id:string;started_at_ms:number;ended_at_ms:number;last_observed_at_ms:number;offline_checks:number;first_missing_at_ms:number|null;url:string|null;title:string}[];
   assert.equal(rows.length,1);
   assert.deepEqual(rows[0],{platform:'twitch',account_id:'account',external_id:'external-1',session_id:platformId,started_at_ms:1000,ended_at_ms:1400,last_observed_at_ms:1300,offline_checks:0,first_missing_at_ms:null,url:null,title:'Latest title'});
   assert.equal((db.pragma('foreign_key_check') as unknown[]).length,0);
  } finally {db.close();}
  const reopened=new StreamStore(path);reopened.close();
  const check=new Database(path);
  try {assert.equal((check.prepare('SELECT count(*) AS n FROM platform_streams').get() as {n:number}).n,1);} finally {check.close();}
  const future=new Database(path);future.pragma('user_version=99');future.close();
  assert.throws(()=>new StreamStore(path),/UNSUPPORTED_SCHEMA_VERSION/);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('platform ledger is isolated by profile, references sessions, and ignores manual sessions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-platform-profiles-'));
 const path=join(dir,'data.sqlite');
 const manualIds=new Map<string,string>();
 try {
  for(const profile of ['ruslan','gulnaz']) {
   const store=new StreamStore(path,profile);
   const id=store.startSession('account','same-external-id',1000,'platform',1100);
   store.startSession('account','same-external-id',1000,'platform',1200);
   store.endSession(id,1400);
   store.endSession(id,1500);
   const manualId=store.startSession('account','manual-id',1200,'manual',1300);
   manualIds.set(profile,manualId);
   assert.equal(store.startSession('account','manual-id',1200,'platform',1300),manualId);
   store.close();
  }
  const db=new Database(path);
  try {
   db.pragma('foreign_keys=ON');
   for(const profile of ['ruslan','gulnaz']) {
    const rows=db.prepare(`SELECT platform,external_id,session_id,ended_at_ms FROM p_${profile}_platform_streams`).all() as {platform:string;external_id:string;session_id:string;ended_at_ms:number|null}[];
    assert.equal(rows.length,1);
    assert.deepEqual(rows.map(row=>[row.platform,row.external_id]),[['twitch','same-external-id']]);
    assert.notEqual(rows[0]!.session_id,manualIds.get(profile));
    assert.equal(rows[0]!.ended_at_ms,1400);
    assert.equal((db.prepare(`SELECT count(*) AS n FROM p_${profile}_sessions WHERE kind='manual'`).get() as {n:number}).n,1);
    assert.equal((db.prepare(`PRAGMA foreign_key_check(p_${profile}_platform_streams)`).all()).length,0);
    assert.throws(()=>db.prepare(`INSERT INTO p_${profile}_platform_streams(platform,account_id,external_id,session_id,started_at_ms,last_observed_at_ms) VALUES ('twitch','x','missing','missing',1,1)`).run());
   }
  } finally {db.close();}
 } finally {await rm(dir,{recursive:true,force:true});}
});
