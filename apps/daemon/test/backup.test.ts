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
 let remote:string[]=['unrelated.sqlite'],privateBucket=true,fail=false;
 const request:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));assert.equal((init!.headers as any).Authorization,'Bearer service');
  if(fail)return Response.json({}, {status:500});
  if(url.pathname.includes('/bucket/'))return Response.json({public:!privateBucket});
  if(url.pathname.includes('/object/list/'))return Response.json(remote.map(name=>({name})));
  if(init?.method==='DELETE'){const names=JSON.parse(String(init.body)).prefixes.map((x:string)=>x.split('/').at(-1));assert.equal(names.includes('unrelated.sqlite'),false);remote=remote.filter(x=>!names.includes(x));}
  else remote.push(url.pathname.split('/').at(-1)!);
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
  privateBucket=false;await assert.rejects(backup.run(),/BACKUP_BUCKET_MUST_BE_PRIVATE/);privateBucket=true;fail=true;await assert.rejects(backup.run(),/BACKUP_UPLOAD_FAILED/);fail=false;
  const local=new BackupService(dir,{keyFile:join(dir,'key')});await local.run();assert.equal(local.status.state,'local');await local.stop();
  const invalid=new BackupService(dir,{keyFile:join(dir,'key'),url:'http://evil.test'});await assert.rejects(invalid.run(),/INVALID_BACKUP_REMOTE/);
  await writeFile(join(dir,'key'),'bad');await assert.rejects(backup.run(),/INVALID_BACKUP_KEY/);
 }finally{await backup.stop();a.close();b.close();auth.close();await rm(dir,{recursive:true,force:true});}
});
