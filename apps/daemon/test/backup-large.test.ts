import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat,open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AccountStore} from '../src/auth.js';
import {StreamStore} from '../../../packages/core/src/store.js';
import {BackupService,restoreBackupFile} from '../src/backup.js';
import {CloudBackup} from '../src/cloud-backup.js';
import {sealBackupFile} from '../src/backup-stream.js';

test('large SQLite uses streaming encrypted backup and restores data, credentials and revoked sessions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-large-backup-')),key=randomBytes(32),path=join(dir,'data.sqlite');
 const auth=new AccountStore(path),store=new StreamStore(path,'ruslan');
 try {
  await auth.createUser('ruslan','owner','Owner','long-backup-password');
  const login=await auth.login('owner','long-backup-password','ip');
  assert.ok(login);
  await writeFile(join(dir,'key'),key.toString('hex'));
  await mkdir(join(dir,'profiles','ruslan'),{recursive:true});
  await writeFile(join(dir,'profiles','ruslan','secrets.json'),JSON.stringify({version:1,daAccessToken:'retained-access',daRefreshToken:'retained-refresh'}));
  const fixture=new Database(path);
  fixture.exec('CREATE TABLE retained_large_data(payload BLOB)');
  fixture.prepare('INSERT INTO retained_large_data VALUES (zeroblob(?))').run(41*1024*1024);
  fixture.close();
  const backup=new BackupService(dir,{keyFile:join(dir,'key')});
  await mkdir(join(dir,'backups'));await writeFile(join(dir,'backups','verify.tmp'),'old interrupted verification');
  const result=await backup.run(),filename=join(dir,'backups',result.filename);
  assert.equal((await readFile(filename)).subarray(0,5).toString(),'SPBK2');
  assert.equal(backup.status.local.state,'success');
  assert.equal(backup.status.cloud.state,'disabled');
  const listed=await backup.files();assert.equal(listed.files[0]?.filename,result.filename);
  const chunks=[];for await(const chunk of await backup.download(result.filename))chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks),await readFile(filename));
  const restored=join(dir,'restored');
  await restoreBackupFile(filename,key,restored);
  const db=new Database(join(restored,'data.sqlite'),{readonly:true});
  try {
   assert.equal((db.prepare('SELECT length(payload) AS size FROM retained_large_data').get() as any).size,41*1024*1024);
   assert.equal((db.prepare('SELECT count(*) AS total FROM sp_auth_sessions').get() as any).total,0);
   assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  } finally {db.close();}
  assert.equal(JSON.parse(await readFile(join(restored,'profiles','ruslan','secrets.json'),'utf8')).daRefreshToken,'retained-refresh');
  assert.ok(auth.session(`sp_session=${login.token}`),'restore into a different directory preserves live sessions');
  await assert.rejects(restoreBackupFile(filename,key,restored),/EEXIST/);
  const tampered=Buffer.from(await readFile(filename));tampered[tampered.length-1]=tampered[tampered.length-1]!^1;
  const invalid=join(dir,'invalid.spbk');await writeFile(invalid,tampered);
  await assert.rejects(restoreBackupFile(invalid,key,join(dir,'invalid-restore')),/BACKUP_INVALID/);
  await assert.rejects(stat(join(dir,'invalid-restore')),/ENOENT/);
  await writeFile(join(dir,'service-key'),'fixture-service-key');
  let uploaded:Buffer|undefined,remoteName='';
  const request:typeof fetch=async(input,options)=>{
   const url=String(input);
   if(url.includes('/bucket/'))return Response.json({public:false});
   if(url.includes('/object/list/'))return Response.json([{name:remoteName}]);
   if(url.includes('/object/authenticated/'))return new Response(new Uint8Array(uploaded!));
   remoteName=url.split('/').at(-1)!;uploaded=Buffer.from(options!.body as Uint8Array);
   return Response.json({ok:true});
  };
  const cloud=new BackupService(dir,{keyFile:join(dir,'key'),url:'https://test.supabase.co',serviceKeyFile:join(dir,'service-key')},request);
  const remote=await cloud.run();
  assert.equal(remote.cloudError,undefined);
  assert.equal(uploaded!.subarray(0,5).toString(),'SPBK2');
  assert.equal(cloud.status.cloud.state,'success');
  assert.equal(cloud.status.local.state,'success');
 } finally {store.close();auth.close();await rm(dir,{recursive:true,force:true});}
});

test('backup low disk space preserves database and existing copies; oversized database fails before copying',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-backup-storage-')),key=randomBytes(32);
 const path=join(dir,'data.sqlite'),auth=new AccountStore(path);
 try {
  await writeFile(join(dir,'key'),key.toString('hex'));
  const before=await readFile(path);
  const backup=new BackupService(dir,{keyFile:join(dir,'key')},fetch,readFile,async()=>1);
  await assert.rejects(backup.run(),/BACKUP_STORAGE_LIMIT/);
  assert.deepEqual(await readFile(path),before);
  assert.equal(backup.status.local.state,'error');
 } finally {auth.close();await rm(dir,{recursive:true,force:true});}
 const sparse=await mkdtemp(join(tmpdir(),'sp-backup-oversize-'));
 try {
  await writeFile(join(sparse,'key'),key.toString('hex'));
  const handle=await open(join(sparse,'data.sqlite'),'wx');
  try{await handle.truncate(64*1024*1024*1024+1);}finally{await handle.close();}
  const backup=new BackupService(sparse,{keyFile:join(sparse,'key')});
  await assert.rejects(backup.run(),/BACKUP_SIZE_LIMIT/);
  assert.equal((await stat(join(sparse,'data.sqlite'))).size,64*1024*1024*1024+1);
 } finally {await rm(sparse,{recursive:true,force:true});}
});

test('large cloud backup verifies bounded parts and restores the complete database',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-large-cloud-')),key=randomBytes(32),path=join(dir,'data.sqlite');
 const auth=new AccountStore(path),objects=new Map<string,Buffer>();
 const request:typeof fetch=async(input,init)=>{
  const p=new URL(String(input)).pathname,base='/storage/v1/object/';
  if(p.includes('/bucket/'))return Response.json({public:false});
  if(p.includes('/object/list/')){const prefix=JSON.parse(String(init?.body)).prefix.replace(/^stream-panel\/?/,'');return Response.json([...new Set([...objects.keys()].filter(k=>k.startsWith(prefix)).map(k=>k.slice(prefix.length).replace(/^\//,'').split('/')[0]!))].map(name=>({name})));}
  if(p.includes('/object/authenticated/')){const name=p.split('/stream-panel/')[1]!,bytes=objects.get(name);return bytes?new Response(new Uint8Array(bytes)):Response.json({},{status:404});}
  if(init?.method==='DELETE'){for(const n of JSON.parse(String(init.body)).prefixes)objects.delete(n.replace(/^stream-panel\//,''));return Response.json({});}
  const name=p.slice(base.length).split('/stream-panel/')[1]!;objects.set(name,Buffer.from(init?.body as Uint8Array));return Response.json({});
 };
 try {
  await writeFile(join(dir,'key'),key.toString('hex'));await writeFile(join(dir,'service'),'fixture');
  const db=new Database(path);db.exec('CREATE TABLE retained_large_data(payload BLOB); INSERT INTO retained_large_data VALUES(randomblob(49*1024*1024))');db.close();
  const backup=new BackupService(dir,{keyFile:join(dir,'key'),url:'https://test.supabase.co',serviceKeyFile:join(dir,'service')},request);
  const result=await backup.run();assert.equal(result.cloudError,undefined);assert.equal(backup.status.cloud.state,'success');
  const installation=JSON.parse(await readFile(join(dir,'backup-state.json'),'utf8')).installationId;
  const manifest=JSON.parse(objects.get(installation+'/'+result.filename+'.manifest.json')!.toString());assert.ok(manifest.parts.length>=4);assert.ok(manifest.parts.every((p:any)=>p.size<=16*1024*1024));
  const cloud=new CloudBackup({url:'https://test.supabase.co',serviceKeyFile:join(dir,'service'),prefix:'stream-panel/'+installation},request),downloaded=join(dir,'remote.spbk');
  await cloud.downloadFile(result.filename,downloaded);await restoreBackupFile(downloaded,key,join(dir,'restored'));
  const restored=new Database(join(dir,'restored','data.sqlite'),{readonly:true});try{assert.equal((restored.prepare('SELECT length(payload) AS n FROM retained_large_data').get() as any).n,49*1024*1024);assert.equal(restored.pragma('integrity_check',{simple:true}),'ok');}finally{restored.close();}
  const part=objects.get(installation+'/'+manifest.parts[0].name)!;part[0]=part[0]!^1;
  await assert.rejects(cloud.downloadFile(result.filename,join(dir,'corrupt.spbk')),/BACKUP_UPLOAD_VERIFY_FAILED/);await assert.rejects(stat(join(dir,'corrupt.spbk')),/ENOENT/);
 }finally{auth.close();await rm(dir,{recursive:true,force:true});}
});

test('file restore supports old backups and rejects malformed authenticated v2 metadata and invalid databases',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-stream-restore-invalid-')),key=randomBytes(32);
 const auth=new AccountStore(join(dir,'data.sqlite'));
 try {
  await writeFile(join(dir,'key'),key.toString('hex'));
  const backup=new BackupService(dir,{keyFile:join(dir,'key')});
  const {filename}=await backup.run();
  await restoreBackupFile(join(dir,'backups',filename),key,join(dir,'old-restored'));
  for(const [name,payload] of [
   ['short',Buffer.alloc(2)],['length',Buffer.from([0xff,0xff,0xff,0xff])],
   ['json',Buffer.concat([Buffer.from([0,0,0,1]),Buffer.from('{')])],
   ['version',Buffer.concat([Buffer.from([0,0,0,13]),Buffer.from('{"version":2}')])],
   ['database',Buffer.concat([Buffer.from([0,0,0,27]),Buffer.from('{"version":1,"profiles":{}}\n'),Buffer.from('not sqlite')])],
  ] as const) {
   const input=join(dir,name+'.spbk'),destination=join(dir,name+'-restore');
   await sealBackupFile((async function*(){yield payload;})(),input,key);
   await assert.rejects(restoreBackupFile(input,key,destination));
   await assert.rejects(stat(destination),/ENOENT/);
  }
  const unknown=join(dir,'unknown.spbk');await writeFile(unknown,'UNKNOWN');
  await assert.rejects(restoreBackupFile(unknown,key,join(dir,'unknown-restore')),/BACKUP_INVALID/);
 } finally {auth.close();await rm(dir,{recursive:true,force:true});}
});
