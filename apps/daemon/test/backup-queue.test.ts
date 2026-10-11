import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomBytes} from 'node:crypto';
import {AccountStore} from '../src/auth.js';import {StreamStore} from '../../../packages/core/src/store.js';
import {BackupService,restoreBackup} from '../src/backup.js';
test('upload queue survives restart, respects backoff, verifies duplicate POST and isolates restored installations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-queue-')),key=randomBytes(32),auth=new AccountStore(join(dir,'data.sqlite')),store=new StreamStore(join(dir,'data.sqlite'),'ruslan');
 await writeFile(join(dir,'key'),key.toString('hex'));await writeFile(join(dir,'service'),'fixture');
 let failing=true,requests=0;const objects=new Map<string,Buffer>(),deletes:string[]=[];
 const request:typeof fetch=async(input,init)=>{
  requests++;const url=new URL(String(input));
  if(url.pathname.includes('/bucket/'))return Response.json({public:false});
  if(url.pathname.includes('/object/list/')){const prefix=JSON.parse(String(init?.body)).prefix+'/';return Response.json([...objects.keys()].filter(n=>n.startsWith(prefix)).map(n=>({name:n.slice(prefix.length)})));}
  if(init?.method==='DELETE'){const names=JSON.parse(String(init.body)).prefixes;deletes.push(...names);for(const n of names)objects.delete(n);return Response.json({});}
  const name=url.pathname.split('/stream-panel-backups/')[1]!;
  if(url.pathname.includes('/object/authenticated/'))return objects.has(name)?new Response(new Uint8Array(objects.get(name)!)):Response.json({},{status:404});
  if(failing)return Response.json({},{status:503});
  if(objects.has(name))return Response.json({},{status:409});
  objects.set(name,Buffer.from(init!.body as Uint8Array));return Response.json({});
 };
 const options={keyFile:join(dir,'key'),serviceKeyFile:join(dir,'service'),url:'https://fixture.supabase.co'};
 try{
  const first=new BackupService(dir,options,request),result=await first.run();assert.equal(result.cloudError,'BACKUP_UPLOAD_FAILED');
  const blob=await readFile(join(dir,'backups',result.filename));await first.stop();
  const ledger=JSON.parse(await readFile(join(dir,'backup-state.json'),'utf8'));assert.deepEqual(ledger.pending,[result.filename]);assert.equal(ledger.attempts,1);
  const restarted=new BackupService(dir,options,request);assert.equal(await restarted.runIfDue(),undefined);assert.equal(restarted.status.pendingUploads,1);assert.equal(restarted.status.nextRetryAt,ledger.retryAt);
  const before=requests;await restarted.retryPending(ledger.retryAt-1);assert.equal(requests,before);
  failing=false;await restarted.retryPending(ledger.retryAt);assert.equal(restarted.status.cloud.state,'success');
  const remoteName='stream-panel/'+ledger.installationId+'/'+result.filename;assert.deepEqual(objects.get(remoteName),blob);
  await restarted.stop();
  const saved=JSON.parse(await readFile(join(dir,'backup-state.json'),'utf8'));saved.pending=[result.filename];saved.uploaded=[];saved.retryAt=0;
  await writeFile(join(dir,'backup-state.json'),JSON.stringify(saved));
  const replay=new BackupService(dir,options,request);await replay.retryPending();assert.equal(replay.status.cloud.state,'success');assert.deepEqual(objects.get(remoteName),blob);assert.deepEqual(deletes,[]);await replay.stop();
  const clone=join(dir,'clone');await restoreBackup(blob,key,clone);await writeFile(join(clone,'key'),key.toString('hex'));await writeFile(join(clone,'service'),'fixture');
  const independent=new BackupService(clone,{...options,keyFile:join(clone,'key'),serviceKeyFile:join(clone,'service')},request);await independent.run();
  const next=JSON.parse(await readFile(join(clone,'backup-state.json'),'utf8'));assert.notEqual(next.installationId,ledger.installationId);assert.ok(objects.has(remoteName));await independent.stop();
 }finally{store.close();auth.close();await rm(dir,{recursive:true,force:true});}
});
test('corrupt queue metadata is reported and never overwritten; unrelated files are preserved',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-queue-invalid-'));
 try{
  const path=join(dir,'backup-state.json');
  for(const contents of ['bad JSON',JSON.stringify({version:2}),JSON.stringify({version:1,installationId:'../other',uploaded:[],pending:[],attempts:0,retryAt:0})]){
   await writeFile(path,contents);const backup=new BackupService(dir,{keyFile:join(dir,'key')});await assert.rejects(backup.runIfDue(),/BACKUP_STATE_INVALID/);assert.equal(await readFile(path,'utf8'),contents);await backup.stop();
  }
  await rm(path);await mkdir(join(dir,'backups'));await writeFile(join(dir,'backups','unrelated'),'keep');
  const backup=new BackupService(dir,{keyFile:join(dir,'key')});await backup.retryPending();assert.equal(await readFile(join(dir,'backups','unrelated'),'utf8'),'keep');await backup.stop();
 }finally{await rm(dir,{recursive:true,force:true});}
});
