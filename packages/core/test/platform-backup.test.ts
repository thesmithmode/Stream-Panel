import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CURRENT_SCHEMA_VERSION} from '../src/schema.js';
import {StreamStore} from '../src/store.js';

test('online backup validates the current schema version for plain and profile stores',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-platform-backup-'));
 try {
  const plain=new StreamStore(join(dir,'plain.sqlite'));
  try {
   const id=plain.startSession('account','stream',1000,'platform',1100);
   plain.attachPlatformStream(id,'youtube','channel','video',1050,1200,'https://youtube.com/watch?v=video','Title');
   const backupPath=join(dir,'plain-backup.sqlite');
   await plain.backup(backupPath);
   const snapshot=new Database(backupPath,{readonly:true,fileMustExist:true});
   try {
    assert.equal(snapshot.pragma('user_version',{simple:true}),CURRENT_SCHEMA_VERSION);
    assert.equal((snapshot.prepare('SELECT count(*) AS n FROM platform_streams').get() as {n:number}).n,2);
   } finally {snapshot.close();}
  } finally {plain.close();}

  const profile=new StreamStore(join(dir,'profile.sqlite'),'ruslan');
  try {
   const id=profile.startSession('account','stream',1000,'platform',1100);
   profile.attachPlatformStream(id,'youtube','channel','video',1050,1200,'https://youtube.com/watch?v=video','Title');
   const backupPath=join(dir,'profile-backup.sqlite');
   await profile.backup(backupPath);
   const snapshot=new Database(backupPath,{readonly:true,fileMustExist:true});
   try {
    assert.equal((snapshot.prepare('SELECT version FROM sp_profile_schema WHERE profile=?').get('ruslan') as {version:number}).version,CURRENT_SCHEMA_VERSION);
    assert.equal((snapshot.prepare('SELECT count(*) AS n FROM p_ruslan_platform_streams').get() as {n:number}).n,2);
   } finally {snapshot.close();}
  } finally {profile.close();}
 } finally {await rm(dir,{recursive:true,force:true});}
});
