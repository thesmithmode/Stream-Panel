import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,rm,symlink,truncate} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BackupService} from '../src/backup.js';
test('acknowledged local copies follow the thirty-day policy; pending copies, unrelated files and links survive',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-retention-')),folder=join(dir,'backups');
 const now=Date.parse('2026-10-10T12:00:00Z');
 const name=(at:number)=>`stream-panel-${new Date(at).toISOString().replace(/[:.]/g,'-')}-1234abcd.spbk`;
 try {
  await mkdir(folder);const old=name(now-31*86400000),boundary=name(now-29*86400000),recent=name(now-86400000);
  const pending=name(now-40*86400000);
  for(const file of [old,boundary,recent,pending,'unrelated.spbk'])await writeFile(join(folder,file),'keep');
  await symlink(join(folder,'unrelated.spbk'),join(folder,name(now-3*86400000)));
  await writeFile(join(dir,'backup-state.json'),JSON.stringify({version:1,installationId:'a'.repeat(32),uploaded:[old,boundary,recent],pending:[pending],attempts:0,retryAt:0}));
  const backup=new BackupService(dir,{keyFile:join(dir,'missing-key'),url:'https://fixture.supabase.co'});
  await backup.purgeLocal(now);
  const files=await readdir(folder);assert.ok(!files.includes(old));
  assert.ok(files.includes(pending));assert.ok(files.includes(boundary));assert.ok(files.includes(recent));assert.ok(files.includes('unrelated.spbk'));
  assert.ok(files.includes(name(now-3*86400000)));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('backup reads reject malformed, oversized or non-file entries and report invalid storage paths',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-backup-reads-')),folder=join(dir,'backups');
 const backup=new BackupService(dir,{keyFile:join(dir,'missing-key')});
 const name='stream-panel-2099-01-01T00-00-00-000Z-12345678.spbk';
 try{
  assert.deepEqual((await backup.files()).files,[]);
  await assert.rejects(backup.file('../key'),/BACKUP_NOT_FOUND/);
  await mkdir(folder);await writeFile(join(folder,name),Buffer.alloc(40));
  await assert.rejects(backup.file(name),/BACKUP_NOT_FOUND/);
  await truncate(join(folder,name),1);await assert.rejects(backup.download(name),/BACKUP_NOT_FOUND/);
  await truncate(join(folder,name),65*1024*1024+1);await assert.rejects(backup.file(name),/BACKUP_NOT_FOUND/);
  await rm(join(folder,name));await mkdir(join(folder,name));
  await assert.rejects(backup.file(name),/BACKUP_NOT_FOUND/);
  await assert.rejects(backup.download(name),/BACKUP_NOT_FOUND/);
  await rm(folder,{recursive:true});await writeFile(folder,'invalid storage path');
  await assert.rejects(backup.purgeLocal(),{code:'ENOTDIR'});
  await assert.rejects(backup.files(),{code:'ENOTDIR'});
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('an unavailable cloud cannot produce an unbounded queue of local archives',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-backup-bounded-'));
 try{
  const pending=Array.from({length:20},(_,i)=>`stream-panel-2026-10-${String(i+1).padStart(2,'0')}T00-00-00-000Z-1234abcd.spbk`);
  await writeFile(join(dir,'backup-state.json'),JSON.stringify({version:1,installationId:'a'.repeat(32),uploaded:[],pending,attempts:0,retryAt:0}));
  const service=new BackupService(dir,{keyFile:join(dir,'missing-key')});await assert.rejects(service.run(),/BACKUP_QUEUE_LIMIT/);assert.equal(service.status.pendingUploads,20);
 }finally{await rm(dir,{recursive:true,force:true});}
});
