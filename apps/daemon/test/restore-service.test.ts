import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHostedApplication} from '../src/hosted.js';
import {activatePendingRestore,stageRestore,commitRestore} from '../src/restore-service.js';
import {BackupService} from '../src/backup.js';
import {AccountStore} from '../src/auth.js';
import {StreamStore} from '../../../packages/core/src/store.js';
import {Readable} from 'node:stream';
import {receiveRestore} from '../src/restore-service.js';
const origin='https://restore.example.test',base={host:'restore.example.test',origin};
test('credential reads require authentication and CSRF; full import preserves both profiles and restores logins with revoked old sessions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-restore-')),key=join(dir,'key');await writeFile(key,'b'.repeat(64));
 let restarted=0,h=await createHostedApplication(dir,origin,false,{keyFile:key},undefined,false,()=>{restarted++;});
 const login=async(password='restore-password-long')=>{const r=await h.app.inject({method:'POST',url:'/api/v1/auth/login',headers:base,payload:{username:'ruslan',password}});assert.equal(r.statusCode,200,r.body);return {...base,cookie:String(r.headers['set-cookie']).split(';')[0]!, 'x-csrf-token':r.json().csrf};};
 try{
  await h.accounts.createUser('ruslan','ruslan','Руслан','restore-password-long');await h.accounts.createUser('gulnaz','gulnaz','Гульназ','gulnaz-restore-password');const auth=await login();
  const post=(url:string,payload:unknown={},headers:Record<string,string>=auth)=>h.app.inject({method:'POST',url,headers,payload:payload as any});
  for(const url of ['/api/v1/integrations/credentials','/api/v1/backup/key','/api/v1/backups/restore']){
   assert.equal((await post(url,{},base)).statusCode,401);assert.equal((await post(url,{}, {...auth,'x-csrf-token':'invalid'})).statusCode,403);
  }
  for(const profile of ['ruslan','gulnaz'] as const){const c=h.runtimes.get(profile)!.configuration;c.value.daClientId=profile+'-client';c.value.daClientSecret=profile+'-secret';c.value.daAccessToken=profile+'-token';c.value.youtubeClientSecret=profile+'-youtube-secret';await c.save();await h.runtimes.get(profile)!.db.call('youtubeSnapshot','channel','report',{views:profile==='ruslan'?1:2});}
  const credentials=await post('/api/v1/integrations/credentials',{}, {...auth,'x-stream-panel-profile':'gulnaz'});assert.equal(credentials.json().donationalerts.access,'gulnaz-token');assert.equal(credentials.headers['cache-control'],'no-store');assert.equal((await post('/api/v1/backup/key')).json().key,'b'.repeat(64));
  assert.equal((await h.app.inject({url:'/api/v1/status',headers:auth})).body.includes('ruslan-secret'),false);
  const saved=await h.backup!.run(),blob=await h.backup!.file(saved.filename);const file=join(dir,'input.spbk');await writeFile(file,blob);
  h.runtimes.get('ruslan')!.configuration.value.daAccessToken='new-token';await h.runtimes.get('ruslan')!.configuration.save();
  const upload=(bytes:Buffer,extra:Record<string,string>={})=>post('/api/v1/backups/restore',bytes,{...auth,'content-type':'application/octet-stream',...extra});
  assert.equal((await upload(Buffer.from('x'),{'content-length':String(64*1024*1024*1024+1)})).statusCode,413);
  assert.equal((await upload(blob,{'x-backup-key':'bad'})).json().error,'INVALID_BACKUP_KEY');assert.equal((await upload(blob,{'x-backup-key':'a'.repeat(64)})).json().error,'BACKUP_INVALID');assert.equal((await upload(Buffer.from('bad'))).statusCode,400);assert.equal((await post('/api/v1/backups/restore')).json().error,'BACKUP_INVALID');
  await mkdir(join(dir,'restore-pending'));assert.equal((await upload(blob)).statusCode,409);await rm(join(dir,'restore-pending'),{recursive:true});
  assert.equal(h.runtimes.get('ruslan')!.configuration.value.daAccessToken,'new-token');assert.equal(restarted,0);
  const response=await upload(blob);assert.equal(response.statusCode,202,response.body);assert.equal(restarted,1);assert.equal((await h.app.inject({url:'/api/v1/events',headers:auth})).statusCode,503);
  await h.app.close();await activatePendingRestore(dir);assert.equal(await activatePendingRestore(dir),false);
  h=await createHostedApplication(dir,origin,false,{keyFile:key},undefined,false);
  assert.equal(h.accounts.session(auth.cookie),null);await login();
  for(const profile of ['ruslan','gulnaz'] as const){assert.equal(h.runtimes.get(profile)!.configuration.value.daAccessToken,profile+'-token');assert.equal((await h.runtimes.get(profile)!.db.call('youtubeData','channel') as any).snapshots.report.data.views,profile==='ruslan'?1:2);}
  const nextAuth=await login();assert.equal((await post('/api/v1/backups/restore',blob,{...nextAuth,'content-type':'application/octet-stream'})).json().error,'RESTORE_NOT_AVAILABLE');
  await writeFile(key,'bad');assert.equal((await post('/api/v1/backup/key',{},nextAuth)).statusCode,500);
 }finally{await h.app.close();await rm(dir,{recursive:true,force:true});}
});
test('streamed restore limits upload bytes and never overwrites an existing file',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-restore-stream-')),path=join(dir,'input');
 try{await receiveRestore(Readable.from([Buffer.from('abcd')]),path,4);assert.equal((await readFile(path)).toString(),'abcd');await assert.rejects(receiveRestore(Readable.from([Buffer.from('x')]),path),/EEXIST/);await assert.rejects(receiveRestore(Readable.from([Buffer.from('abc'),Buffer.from('def')]),join(dir,'large'),4),/BACKUP_SIZE_LIMIT/);}finally{await rm(dir,{recursive:true,force:true});}
});
test('staging rejects empty accounts and crash recovery retries the entire immutable replacement',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-restore-crash-')),source=join(dir,'source'),target=join(dir,'target'),key=join(dir,'key');await mkdir(source);await mkdir(target);await writeFile(key,'a'.repeat(64));
 const accounts=new AccountStore(join(source,'data.sqlite')),a=new StreamStore(join(source,'data.sqlite'),'ruslan'),b=new StreamStore(join(source,'data.sqlite'),'gulnaz'),backup=new BackupService(source,{keyFile:key});
 try{
  const file=join(dir,'input.spbk');await writeFile(file,await backup.file((await backup.run()).filename));await assert.rejects(stageRestore(file,Buffer.from('a'.repeat(64),'hex'),join(dir,'empty')),/BACKUP_HAS_NO_USERS/);
  await accounts.createUser('ruslan','ruslan','Руслан','crash-test-password');await writeFile(file,await backup.file((await backup.run()).filename));const stage=join(dir,'staged');await stageRestore(file,Buffer.from('a'.repeat(64),'hex'),stage);
  await assert.rejects(commitRestore(target,join(dir,'missing')));assert.equal(await activatePendingRestore(target),false);
  await commitRestore(target,stage);await assert.rejects(commitRestore(target,join(dir,'missing')),/EEXIST/);
  const blocked=join(target,'profiles','ruslan','secrets.json');await mkdir(blocked,{recursive:true});await assert.rejects(activatePendingRestore(target));await rm(blocked,{recursive:true});assert.equal(await activatePendingRestore(target),true);assert.equal(JSON.parse(await readFile(blocked,'utf8')).version,1);
  await mkdir(join(target,'restore-pending'));await writeFile(join(target,'restore-pending','committed'),'complete');await writeFile(join(target,'restoring'),'pending');assert.equal(await activatePendingRestore(target),true);
 }finally{await backup.stop();a.close();b.close();accounts.close();await rm(dir,{recursive:true,force:true});}
});
