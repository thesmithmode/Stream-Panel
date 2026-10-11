import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {spawn} from 'node:child_process';
import {AccountStore} from '../../dist/apps/daemon/src/auth.js';import {StreamStore} from '../../dist/packages/core/src/store.js';import {BackupService} from '../../dist/apps/daemon/src/backup.js';
const run=(args,env)=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('exit',code=>resolve({code,out,err}));});
test('deployment cloud verification downloads and restores both profiles without exposing credentials',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-cloud-audit-')),path=join(dir,'data.sqlite'),key=join(dir,'backup-key'),service=join(dir,'service-key');
 const auth=new AccountStore(path),rus=new StreamStore(path,'ruslan'),gul=new StreamStore(path,'gulnaz');
 try{
  rus.providerSnapshot('twitch','owner','unanalysed',{retained:true},Date.now());gul.createPerson('Retained person');
  await writeFile(key,'a'.repeat(64));await writeFile(service,'private-service-key');const backup=new BackupService(dir,{keyFile:key});const {filename}=await backup.run();
  const shim=join(dir,'mock-cloud.mjs');await writeFile(shim,`import {readFile} from 'node:fs/promises';globalThis.fetch=async input=>String(input).includes('/bucket/')?Response.json({public:false}):new Response(new Uint8Array(await readFile(${JSON.stringify(join(dir,'backups',filename))})));`);
  const env={STREAM_PANEL_DATA_DIR:dir,STREAM_PANEL_SUPABASE_URL:'https://fixture.supabase.co',STREAM_PANEL_BACKUP_KEY_FILE:key,STREAM_PANEL_SUPABASE_KEY_FILE:service};
  const result=await run(['--import',shim,resolve('scripts/verify-cloud-backup.mjs')],env);assert.equal(result.code,0,result.err);
  const report=JSON.parse(result.out);assert.equal(report.cloud.restoreVerified,true);assert.equal(report.cloud.hashVerified,true);assert.equal(report.cloud.filename,filename);assert.equal(report.backup.counts,undefined);assert.equal(report.live.counts,undefined);assert.equal(report.backup.tables,report.live.tables);assert.deepEqual(report.backup.schemas,report.live.schemas);assert.ok(!result.out.includes('private-service-key'));
  const missing=await run([resolve('scripts/verify-cloud-backup.mjs')],{...env,STREAM_PANEL_SUPABASE_URL:''});assert.notEqual(missing.code,0);assert.match(missing.err,/CLOUD_BACKUP_NOT_CONFIGURED/);const local=JSON.parse(missing.out);assert.equal(local.live.integrity,'ok');assert.deepEqual(local.live.schemas,report.live.schemas);assert.equal(local.cloud.state,'not_configured');assert.ok(!missing.out.includes('private-service-key'));const noDirectory=await run([resolve('scripts/verify-cloud-backup.mjs')],{...env,STREAM_PANEL_DATA_DIR:''});assert.match(noDirectory.err,/CLOUD_BACKUP_NOT_CONFIGURED/);assert.equal(noDirectory.out,'');
 }finally{rus.close();gul.close();auth.close();await rm(dir,{recursive:true,force:true});}
});
