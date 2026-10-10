import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHostedApplication} from '../src/hosted.js';

test('backup listing and encrypted downloads require login, reject cross-site reads and never follow symlinks or traversal',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-backup-download-')),key=join(dir,'key');await writeFile(key,'a'.repeat(64));
 const h=await createHostedApplication(dir,'https://panel.example.test',false,{keyFile:key});const base={host:'panel.example.test',origin:'https://panel.example.test'};
 try {
  await h.accounts.createUser('ruslan','ruslan','Руслан','backup-download-password');
  const login=await h.app.inject({method:'POST',url:'/api/v1/auth/login',headers:base,payload:{username:'ruslan',password:'backup-download-password'}});
  const headers={...base,cookie:String(login.headers['set-cookie']).split(';')[0]!};
  assert.equal((await h.app.inject({url:'/api/v1/backups',headers:base})).statusCode,401);
  const empty=await h.app.inject({url:'/api/v1/backups',headers});assert.equal(empty.statusCode,200);assert.deepEqual(empty.json().files,[]);
  const {filename}=await h.backup!.run();
  const list=await h.app.inject({url:'/api/v1/backups',headers});assert.equal(list.statusCode,200);assert.equal(list.json().directory,join(dir,'backups'));assert.equal(list.json().files[0].filename,filename);
  assert.equal(list.json().local.state,'success');assert.equal(list.json().cloud.state,'disabled');
  const file=await h.app.inject({url:`/api/v1/backups/${filename}`,headers});assert.equal(file.statusCode,200);assert.equal(file.rawPayload.subarray(0,5).toString(),'SPBK1');assert.match(String(file.headers['content-disposition']),/attachment/);assert.equal(file.headers['cache-control'],'no-store');
  assert.equal((await h.app.inject({url:`/api/v1/backups/${filename}`,headers:base})).statusCode,401);
  assert.equal((await h.app.inject({url:`/api/v1/backups/${filename}`,headers:{...headers,'sec-fetch-site':'cross-site'}})).statusCode,403);
  assert.equal((await h.app.inject({url:`/api/v1/backups/${filename}`,headers:{...headers,origin:'https://evil.test'}})).statusCode,403);
  assert.equal((await h.app.inject({url:'/api/v1/backups/secrets.json',headers})).statusCode,404);
  assert.equal((await h.app.inject({url:'/api/v1/backups/..%2Fkey',headers})).statusCode,404);
  const link='stream-panel-2026-10-01T00-00-00-000Z-12345678.spbk';await symlink(key,join(dir,'backups',link));
  assert.equal((await h.app.inject({url:`/api/v1/backups/${link}`,headers})).statusCode,404);
  await writeFile(join(dir,'backups','stream-panel-2026-10-01T00-00-00-000Z-12345679.spbk'),'not encrypted'.repeat(4));
  assert.equal((await h.app.inject({url:'/api/v1/backups/stream-panel-2026-10-01T00-00-00-000Z-12345679.spbk',headers})).statusCode,404);
  const after=await h.app.inject({url:'/api/v1/backups',headers});assert.equal(after.json().files.some((f:any)=>f.filename===link),false);
 }finally{await h.app.close();await rm(dir,{recursive:true,force:true});}
});
