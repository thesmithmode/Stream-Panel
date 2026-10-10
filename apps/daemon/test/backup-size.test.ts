import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AccountStore} from '../src/auth.js';
import {BackupService} from '../src/backup.js';
import {openBackup,sealBackup} from '../src/backup.js';

const maxPayloadSize = 64 * 1024 * 1024;

test('backup payload size limit matches the maximum output accepted when opening a backup',()=>{
 const key=randomBytes(32);
 const payload=Buffer.alloc(maxPayloadSize,0x5a);
 const blob=sealBackup(payload,key);
 assert.deepEqual(openBackup(blob,key),payload);
 assert.throws(()=>sealBackup(Buffer.alloc(maxPayloadSize+1),key),/BACKUP_SIZE_LIMIT/);
});

test('backup size guard keeps malformed keys and backup headers rejected',()=>{
 assert.throws(()=>sealBackup(Buffer.alloc(0),Buffer.alloc(1)),/INVALID_BACKUP_KEY/);
 assert.throws(()=>openBackup(Buffer.alloc(1),Buffer.alloc(32)),/INVALID_BACKUP/);
});

test('backup service rejects oversized metadata after snapshot and removes temporary files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-backup-size-'));
 const auth=new AccountStore(join(dir,'data.sqlite'));
 try {
  await auth.createUser('ruslan','ruslan','Руслан','long-backup-password');
  await writeFile(join(dir,'key'),randomBytes(32).toString('hex'));
  await mkdir(join(dir,'profiles','ruslan'),{recursive:true});
  await writeFile(join(dir,'profiles','ruslan','secrets.json'),JSON.stringify({payload:'x'.repeat(maxPayloadSize)}));
  const backup=new BackupService(dir,{keyFile:join(dir,'key')});
  await assert.rejects(backup.run(),/BACKUP_SIZE_LIMIT/);
  const files=await readdir(join(dir,'backups'));
  assert.equal(files.some(name=>name.endsWith('.spbk')),false);
  assert.equal(files.includes('snapshot.tmp.sqlite'),false);
 } finally {auth.close();await rm(dir,{recursive:true,force:true});}
});
