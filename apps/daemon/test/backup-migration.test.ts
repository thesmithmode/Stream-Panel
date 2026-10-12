import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {StreamStore} from '../../../packages/core/src/store.js';
import {BackupService,restoreBackupFile} from '../src/backup.js';
import {AccountStore} from '../src/auth.js';

test('a schema migration creates a fresh restorable backup immediately, while unchanged restarts obey the interval',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-backup-migration-')),key=randomBytes(32),path=join(dir,'data.sqlite'),options={keyFile:join(dir,'key')};
 const accounts=new AccountStore(path);accounts.close();
 for(const profile of ['ruslan','gulnaz']){const store=new StreamStore(path,profile);store.close();}
 await writeFile(options.keyFile,key.toString('hex'));
 const services:BackupService[]=[];
 const open=()=>{const service=new BackupService(dir,options);services.push(service);return service;};
 try{
  const first=await open().run();
  assert.equal(await open().runIfDue(),undefined);
  const db=new Database(path);db.exec('CREATE TABLE migration_fact (value TEXT); INSERT INTO migration_fact VALUES (\'preserved\')');db.close();
  const migrated=await open().runIfDue();assert.ok(migrated);assert.notEqual(migrated.filename,first.filename);
  const restored=join(dir,'restored');await restoreBackupFile(join(dir,'backups',migrated.filename),key,restored);
  const check=new Database(join(restored,'data.sqlite'),{readonly:true});try{assert.deepEqual(check.prepare('SELECT value FROM migration_fact').get(),{value:'preserved'});}finally{check.close();}
  assert.equal(await open().runIfDue(),undefined);
  const ledger=JSON.parse(await readFile(join(dir,'backup-state.json'),'utf8'));delete ledger.schemaSignature;await writeFile(join(dir,'backup-state.json'),JSON.stringify(ledger));
  assert.ok(await open().runIfDue(),'legacy ledgers require one schema-confirmed snapshot');
  assert.equal(await open().runIfDue(),undefined);
 }finally{for(const service of services)await service.stop();await rm(dir,{recursive:true,force:true});}
});
