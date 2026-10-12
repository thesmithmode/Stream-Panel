import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,readFile,rm,truncate,stat} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {BackupService} from '../src/backup.js';import {StorageGuard,STORAGE_RESERVE_BYTES,STORAGE_MIN_FREE_BYTES} from '../src/storage-guard.js';
test('collection continues below the soft one GB reserve; cleanup coalesces and only actual exhaustion blocks writes',async()=>{
 let free=STORAGE_RESERVE_BYTES-1,cleanups=0,now=10000;const guard=new StorageGuard('/fixture/data.sqlite',async()=>free,()=>now,async()=>{cleanups++;});
 await Promise.all([guard.check(),guard.check()]);assert.equal(cleanups,1);await guard.check();assert.equal(cleanups,1);
 now+=5000;free=STORAGE_MIN_FREE_BYTES-1;await assert.rejects(guard.check(),/STORAGE_FULL/);
 now+=5000;free=STORAGE_MIN_FREE_BYTES;await guard.check();
 const recovered=new StorageGuard('/fixture/data.sqlite',async()=>free,()=>now,async()=>{free=STORAGE_RESERVE_BYTES;});free=0;await recovered.check();assert.equal(recovered.status().freeBytes,STORAGE_RESERVE_BYTES);
 const failed=new StorageGuard('/fixture/data.sqlite',async()=>STORAGE_RESERVE_BYTES-1,()=>now,async()=>{throw new Error('cleanup failure');});await failed.check();assert.equal(failed.status().cleanupFailed,true);
});
test('local-only backups clear legacy upload pins, keep at least seven recovery points and clean owned crash leftovers',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-hygiene-')),folder=join(dir,'backups'),now=Date.now();
 const names=Array.from({length:25},(_,i)=>`stream-panel-${new Date(now-i*3600000).toISOString().replace(/[:.]/g,'-')}-1234abcd.spbk`);
 try{await mkdir(folder);for(const name of names)await writeFile(join(folder,name),'verified fixture');
 await writeFile(join(dir,'backup-state.json'),JSON.stringify({version:1,installationId:'a'.repeat(32),uploaded:[],pending:names,attempts:0,retryAt:0}));
 for(const name of ['snapshot.tmp.sqlite',names[0]+'.tmp',names[0]+'.verify.tmp','my-important.tmp'])await writeFile(join(folder,name),'keep');
 const service=new BackupService(dir,{keyFile:join(dir,'missing-key')});await service.purgeLocal(now);const files=await readdir(folder);
 assert.equal(service.status.pendingUploads,0);for(const name of names.slice(0,7))assert.ok(files.includes(name));assert.ok(files.length<15);assert.ok(files.includes('my-important.tmp'));assert.ok(!files.includes('snapshot.tmp.sqlite'));
 const state=JSON.parse(await readFile(join(dir,'backup-state.json'),'utf8'));assert.deepEqual(state.pending,[]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('cloud failure retains fresh recovery points while superseded pending snapshots stop pinning disk forever',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-cloud-retention-')),folder=join(dir,'backups'),now=Date.now();
 const names=Array.from({length:25},(_,i)=>`stream-panel-${new Date(now-i*86400000).toISOString().replace(/[:.]/g,'-')}-1234abcd.spbk`);
 try{await mkdir(folder);for(const name of names)await writeFile(join(folder,name),'fixture');await writeFile(join(dir,'backup-state.json'),JSON.stringify({version:1,installationId:'a'.repeat(32),uploaded:[],pending:names,attempts:2,retryAt:now+60000}));
 const service=new BackupService(dir,{keyFile:join(dir,'missing-key'),url:'https://fixture.supabase.co'});await service.purgeLocal(now);const files=await readdir(folder);assert.ok(files.length<=10);for(const name of names.slice(0,7))assert.ok(files.includes(name));assert.equal(service.status.pendingUploads,files.length);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('large optional calendar backups fit the byte budget without deleting the latest seven recovery points',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-byte-budget-')),folder=join(dir,'backups'),now=Date.now();
 const names=Array.from({length:12},(_,i)=>`stream-panel-${new Date(now-i*86400000).toISOString().replace(/[:.]/g,'-')}-1234abcd.spbk`);
 try{await mkdir(folder);for(const name of names){await writeFile(join(folder,name),'fixture');await truncate(join(folder,name),256*1024**2);}
 const service=new BackupService(dir,{keyFile:join(dir,'unused')});await service.purgeLocal(now);const files=await readdir(folder);let bytes=0;for(const name of files)bytes+=(await stat(join(folder,name))).size;assert.ok(bytes<=2*1024**3);for(const name of names.slice(0,7))assert.ok(files.includes(name));
 }finally{await rm(dir,{recursive:true,force:true});}
});
