import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {schemaMigrations} from '../src/schema.js';import {StreamStore} from '../src/store.js';import {openProfileDatabase} from '../src/profile-db.js';
function legacy(db:Database.Database){for(const sql of schemaMigrations.slice(0,19))db.exec(sql);}
function fixture(db:Database.Database){db.exec("INSERT INTO persons VALUES('person','Viewer',0);INSERT INTO identities VALUES('identity','twitch','owner','viewer','Viewer','viewer','person','viewer');INSERT INTO sessions VALUES('session','owner','stream','platform',60000,60000,240000,'observed');INSERT INTO presence_polls VALUES('poll','session','owner',60000,119999,'complete');INSERT INTO presence_polls VALUES('partial','session','owner',120000,179999,'partial');INSERT INTO presence_members VALUES('poll','identity'),('partial','identity')");}
test('legacy memberships migrate exactly with permanent restrictive keys, partial polls and isolated profiles',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-presence-migration-')),path=join(dir,'data.sqlite');
 try{
  for(const profile of ['ruslan','gulnaz']){const d=openProfileDatabase(path,profile);legacy(d);fixture(d);d.close();}
  for(const profile of ['ruslan','gulnaz']){
   const s=new StreamStore(path,profile),d=(s as any).db;
   assert.deepEqual(d.prepare('SELECT * FROM presence_members ORDER BY poll_id').all(),[{poll_id:'partial',identity_id:'identity'},{poll_id:'poll',identity_id:'identity'}]);
   assert.equal(d.prepare('SELECT count(*) n FROM presence_members_compact').get().n,2);
   assert.throws(()=>d.prepare("DELETE FROM identities WHERE id='identity'").run(),/FOREIGN KEY/);assert.throws(()=>d.prepare("DELETE FROM presence_polls WHERE id='poll'").run(),/FOREIGN KEY/);
   assert.equal(s.grid('session','person',60000,240000)[0]!.state,'observed');
   s.recordPoll('session','owner',{startedAtMs:180000,completedAtMs:239999,status:'complete',userIds:['viewer']});assert.equal(d.prepare('SELECT count(*) n FROM presence_members_compact').get().n,3);
   const before=d.prepare("SELECT revision FROM analytics_stream_revisions WHERE session_id='session'").get().revision;
   d.exec("INSERT INTO presence_polls VALUES('moved','session','owner',180000,239999,'complete');UPDATE presence_members SET poll_id='moved' WHERE poll_id='poll'");
   assert.ok(d.prepare("SELECT revision FROM analytics_stream_revisions WHERE session_id='session'").get().revision>before);assert.deepEqual(d.pragma('foreign_key_check'),[]);s.close();
   const reopened=new StreamStore(path,profile);assert.equal((reopened as any).db.prepare('SELECT count(*) n FROM presence_members').get().n,3);reopened.close();
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a mismatched legacy membership rolls back migration before any old links are removed',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-presence-rollback-')),path=join(dir,'data.sqlite');
 try{
  const old=new Database(path);legacy(old);fixture(old);old.pragma('foreign_keys=OFF');old.exec("INSERT INTO presence_members VALUES('missing-poll','identity')");old.close();
  assert.throws(()=>new StreamStore(path),/CHECK constraint/);
  const d=new Database(path);assert.equal(d.pragma('user_version',{simple:true}),19);assert.equal((d.prepare('SELECT count(*) n FROM presence_members').get() as {n:number}).n,3);assert.equal((d.prepare("SELECT count(*) n FROM sqlite_master WHERE name='presence_members_compact'").get() as {n:number}).n,0);d.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
