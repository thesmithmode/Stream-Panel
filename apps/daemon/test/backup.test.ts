import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {StreamStore} from '../../../packages/core/src/store.js';
import {AccountStore} from '../src/auth.js';
import {BackupService,sealBackup,openBackup,restoreBackup} from '../src/backup.js';
test('encrypted online backup restores both profiles and credentials, revokes sessions, rotates only owned objects',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-backup-')),key=randomBytes(32),path=join(dir,'data.sqlite');
 const auth=new AccountStore(path);await auth.createUser('ruslan','ruslan','Руслан','long-backup-password');const login=await auth.login('ruslan','long-backup-password','ip');
 const a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz');a.youtubeSnapshot('channel','report',{views:1});b.youtubeSnapshot('channel','report',{views:2});
 await writeFile(join(dir,'key'),key.toString('hex'));await writeFile(join(dir,'service-key'),'service');
 await mkdir(join(dir,'profiles','ruslan'),{recursive:true});await writeFile(join(dir,'profiles','ruslan','secrets.json'),JSON.stringify({version:1,daAccessToken:'token'}));
  let remote:string[]=['unrelated.sqlite'],privateBucket=true,fail=false;const remoteBlobs=new Map<string,Buffer>();
 const request:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));assert.equal((init!.headers as any).Authorization,'Bearer service');
  if(fail)return Response.json({}, {status:500});
  if(url.pathname.includes('/bucket/'))return Response.json({public:!privateBucket});
   if(url.pathname.includes('/object/authenticated/')){const name=url.pathname.split('/').at(-1)!;const stored=remoteBlobs.get(name);return stored?new Response(new Uint8Array(stored)):Response.json({}, {status:404});}
  if(url.pathname.includes('/object/list/'))return Response.json(remote.map(name=>({name})));
   if(init?.method==='DELETE'){const names=JSON.parse(String(init.body)).prefixes.map((x:string)=>x.split('/').at(-1));assert.equal(names.includes('unrelated.sqlite'),false);remote=remote.filter(x=>!names.includes(x));for(const name of names)remoteBlobs.delete(name);}
   else {const name=url.pathname.split('/').at(-1)!;remote.push(name);remoteBlobs.set(name,Buffer.from(init!.body as Uint8Array));}
  return Response.json({ok:true});
 };
 const backup=new BackupService(dir,{keyFile:join(dir,'key'),url:'https://test.supabase.co',serviceKeyFile:join(dir,'service-key')},request);
 try{
  assert.throws(()=>sealBackup(Buffer.from('hi'),Buffer.alloc(1)),/INVALID_BACKUP_KEY/);assert.throws(()=>openBackup(Buffer.alloc(1),key),/INVALID_BACKUP/);
  const promise=backup.run();assert.equal(backup.run(),promise);const first=await promise;
  const blob=await readFile(join(dir,'backups',first.filename));assert.equal(blob.includes(Buffer.from('token')),false);assert.throws(()=>openBackup(blob,randomBytes(32)));
  await restoreBackup(blob,key,join(dir,'restored'));
  const ra=new StreamStore(join(dir,'restored','data.sqlite'),'ruslan'),rb=new StreamStore(join(dir,'restored','data.sqlite'),'gulnaz'),rAuth=new AccountStore(join(dir,'restored','data.sqlite'));
  try{assert.equal(ra.youtubeData('channel').snapshots.report!.data.views,1);assert.equal(rb.youtubeData('channel').snapshots.report!.data.views,2);assert.equal(rAuth.session(`sp_session=${login!.token}`),null);assert.equal(JSON.parse(await readFile(join(dir,'restored','profiles','ruslan','secrets.json'),'utf8')).daAccessToken,'token');}finally{ra.close();rb.close();rAuth.close();}
  await assert.rejects(restoreBackup(blob,key,join(dir,'restored')),/EEXIST/);
  await assert.rejects(restoreBackup(blob,randomBytes(32),join(dir,'wrong-key')));
  for(let i=0;i<4;i++)await backup.run();assert.equal(remote.filter(x=>x.endsWith('.spbk')).length,3);assert.equal((await readdir(join(dir,'backups'))).filter(x=>x.endsWith('.spbk')).length,3);
  privateBucket=false;const privateFailure=await backup.run();assert.equal(privateFailure.cloudError,'BACKUP_BUCKET_MUST_BE_PRIVATE');assert.equal(backup.status.state,'partial');assert.equal(backup.status.local.filename,privateFailure.filename);privateBucket=true;fail=true;const uploadFailure=await backup.run();assert.equal(uploadFailure.cloudError,'BACKUP_UPLOAD_FAILED');assert.ok(await readFile(join(dir,'backups',uploadFailure.filename)));fail=false;
  const local=new BackupService(dir,{keyFile:join(dir,'key')});await local.run();assert.equal(local.status.state,'local');await local.stop();
  const invalid=new BackupService(dir,{keyFile:join(dir,'key'),url:'http://evil.test'});const invalidRemote=await invalid.run();assert.equal(invalidRemote.cloudError,'INVALID_BACKUP_REMOTE');assert.equal(invalid.status.local.filename,invalidRemote.filename);
  await writeFile(join(dir,'key'),'bad');await assert.rejects(backup.run(),/INVALID_BACKUP_KEY/);
 }finally{await backup.stop();a.close();b.close();auth.close();await rm(dir,{recursive:true,force:true});}
});

test('backup rejects unsafe remote settings, malformed secret metadata and remote verification failures; corrupt restore never leaves a partial directory',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-backup-errors-')),key=randomBytes(32),path=join(dir,'data.sqlite');
 const auth=new AccountStore(path);const s=new StreamStore(path,'ruslan');
 await writeFile(join(dir,'key'),key.toString('hex'));await writeFile(join(dir,'service'),'secret');
 const options={keyFile:join(dir,'key'),serviceKeyFile:join(dir,'service'),url:'https://test.supabase.co'};
 try {
   const privateInfo:typeof fetch=async(input)=>Response.json(String(input).includes('/bucket/')?{public:false}:[]);
  assert.equal((await new BackupService(dir,{...options,bucket:'../other'},privateInfo).run()).cloudError,'INVALID_BACKUP_BUCKET');
  await writeFile(join(dir,'service'),'');assert.equal((await new BackupService(dir,options,privateInfo).run()).cloudError,'MISSING_BACKUP_SERVICE_KEY');await writeFile(join(dir,'service'),'secret');
   let uploaded:Buffer|undefined;
   const malformed:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));
    if(url.pathname.includes('/bucket/'))return Response.json({public:false});
    if(url.pathname.includes('/object/authenticated/'))return new Response(new Uint8Array(uploaded!));
    if(url.pathname.includes('/object/list/'))return Response.json({});
    if(init?.method==='POST')uploaded=Buffer.from(init.body as Uint8Array);
    return Response.json({ok:true});
   };
  assert.equal((await new BackupService(dir,options,malformed).run()).cloudError,'BACKUP_INVALID_LIST');
   assert.equal((await new BackupService(dir,options,privateInfo).run()).cloudError,'BACKUP_UPLOAD_VERIFY_FAILED');
  await writeFile(join(dir,'key'),key.toString('hex')+'invalid');
  await assert.rejects(new BackupService(dir,{keyFile:join(dir,'key')}).run(),/INVALID_BACKUP_KEY/);
  await writeFile(join(dir,'key'),key.toString('hex'));
  await mkdir(join(dir,'profiles','ruslan'),{recursive:true});await writeFile(join(dir,'profiles','ruslan','secrets.json'),'{bad');
  await assert.rejects(new BackupService(dir,{keyFile:join(dir,'key')}).run(),/BACKUP_FAILED/);
  const meta=Buffer.from(JSON.stringify({version:999,profiles:{}})),prefix=Buffer.alloc(4);prefix.writeUInt32BE(meta.length);
  await assert.rejects(restoreBackup(sealBackup(Buffer.concat([prefix,meta,Buffer.from('bad database')]),key),key,join(dir,'invalid-version')),/UNSUPPORTED_BACKUP/);
  const validMeta=Buffer.from(JSON.stringify({version:1,profiles:{}}));prefix.writeUInt32BE(validMeta.length);
  await assert.rejects(restoreBackup(sealBackup(Buffer.concat([prefix,validMeta,Buffer.from('bad database')]),key),key,join(dir,'bad-sqlite')));
  assert.equal((await readdir(dir)).includes('bad-sqlite'),false);
 } finally {s.close();auth.close();await rm(dir,{recursive:true,force:true});}
});

test('corrupt cloud download keeps previous remote copies and skips cloud rotation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-backup-cloud-corrupt-')),path=join(dir,'data.sqlite');
 const store=new StreamStore(path),key=join(dir,'key'),serviceKey=join(dir,'service-key');
 await writeFile(key,randomBytes(32).toString('hex'));await writeFile(serviceKey,'service');
 const previous=['stream-panel-2026-10-01T00-00-00-000Z-00000001.spbk','stream-panel-2026-10-02T00-00-00-000Z-00000002.spbk','stream-panel-2026-10-03T00-00-00-000Z-00000003.spbk'];
 let uploaded:Buffer|undefined,deleted=0,listed=0;const cloudObjects=[...previous];
 const request:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));
  if(url.pathname.includes('/bucket/'))return Response.json({public:false});
  if(url.pathname.includes('/object/authenticated/')){const corrupt=Buffer.from(uploaded!);corrupt[corrupt.length-1]=corrupt.at(-1)!^1;return new Response(new Uint8Array(corrupt));}
  if(url.pathname.includes('/object/list/')){listed++;return Response.json(previous.map(name=>({name})));}
  if(init?.method==='DELETE'){deleted++;return Response.json({ok:true});}
  uploaded=Buffer.from(init!.body as Uint8Array);cloudObjects.push(url.pathname.split('/').at(-1)!);return Response.json({ok:true});
 };
 const backup=new BackupService(dir,{keyFile:key,url:'https://test.supabase.co',serviceKeyFile:serviceKey},request);
 try{
  const result=await backup.run();
  assert.equal(result.cloudError,'BACKUP_UPLOAD_VERIFY_FAILED');
  assert.deepEqual(cloudObjects.slice(0,previous.length),previous);assert.equal(cloudObjects.length,previous.length+1);
  assert.equal(listed,0);assert.equal(deleted,0);
  assert.ok(await readFile(join(dir,'backups',result.filename)));
  assert.equal(backup.status.local.filename,result.filename);
 }finally{await backup.stop();store.close();await rm(dir,{recursive:true,force:true});}
});
