import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
function start(dir, port, extra = {}) {
  const child = spawn(process.execPath, ["dist/apps/daemon/src/index.js"], { env: { ...process.env, STREAM_PANEL_DATA_DIR: dir, STREAM_PANEL_PORT: String(port), STREAM_PANEL_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (b) => stdout += b); child.stderr.on("data", (b) => stderr += b);
  const exit = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal, stdout, stderr })));
  const ready = async () => { const deadline = Date.now() + 15000; while (!stdout.includes("server listening")) { if (child.exitCode !== null) throw new Error(stderr); if (Date.now() > deadline) throw new Error("START_TIMEOUT"); await new Promise((r) => setTimeout(r, 10)); } };
  return { child, exit, ready };
}
test("server entrypoint serves health, rejects a second listener, shuts down and reopens one SQLite", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-server-cli-")); const port = await freePort(); const children = [];
  try {
    const a = start(dir, port); children.push(a); await a.ready();
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/events`)).status, 401);
    const duplicate = start(dir, port); children.push(duplicate); assert.equal((await duplicate.exit).code, 1);
    a.child.kill("SIGTERM"); assert.equal((await a.exit).code, 0);
    const b = start(dir, port); children.push(b); await b.ready(); b.child.kill("SIGINT"); assert.equal((await b.exit).code, 0);
  } finally { for (const c of children) c.child.kill(); await Promise.all(children.map((c) => c.exit)); await rm(dir, { recursive: true, force: true }); }
});
test("server entrypoint fails before exposing data when origin, directory or port is invalid", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-server-invalid-"));
  try {
    for (const [env, expected] of [[{ STREAM_PANEL_PUBLIC_ORIGIN: "" }, "PUBLIC_ORIGIN_REQUIRED"], [{ STREAM_PANEL_DATA_DIR: "" }, "DATA_DIR_REQUIRED"], [{ STREAM_PANEL_PORT: "80" }, "INVALID_PORT"], [{ STREAM_PANEL_PUBLIC_ORIGIN: "http://public.example.test" }, "INVALID_PUBLIC_ORIGIN"]]) {
      const c = start(dir, 47831, env); const r = await c.exit; assert.equal(r.code, 1); assert.match(r.stderr, new RegExp(expected));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('deployment maintenance delays startup backup until promotion; remote configuration errors stay private and do not kill the server', {timeout:15000}, async () => {
  const {writeFile,unlink,readdir}=await import('node:fs/promises');
  const {randomBytes}=await import('node:crypto');
  const dir=await mkdtemp(join(tmpdir(),'sp-server-maintenance-')),port=await freePort();
  let c;
  try {
    await writeFile(join(dir,'deploying'),'');
    await writeFile(join(dir,'initializing'),'');
    await writeFile(join(dir,'key'),randomBytes(32).toString('hex'));
    await writeFile(join(dir,'service'),'fixture');
    c=start(dir,port,{STREAM_PANEL_BACKUP_KEY_FILE:join(dir,'key'),STREAM_PANEL_SUPABASE_URL:'http://invalid.example.test',STREAM_PANEL_SUPABASE_KEY_FILE:join(dir,'service')});
    await c.ready();
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status,200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/events`)).status,503);
    assert.equal((await readdir(dir)).includes('backups'),false);
    await unlink(join(dir,'deploying'));
    await new Promise(r=>setTimeout(r,2300));
    assert.equal((await readdir(dir)).includes('backups'),false,'independent initialization marker still holds collectors and backup');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/events`)).status,503);
    await unlink(join(dir,'initializing'));
    const deadline=Date.now()+7000;
    while (!(await readdir(dir)).includes('backups')) {
      assert.ok(Date.now()<deadline,'startup backup must run after maintenance');
      await new Promise(r=>setTimeout(r,20));
    }
    const snapshotDeadline=Date.now()+3000;
    while (!(await readdir(join(dir,'backups'))).some(x=>x.endsWith('.spbk'))) {
      assert.ok(Date.now()<snapshotDeadline,'local encrypted backup remains available on remote error');
      await new Promise(r=>setTimeout(r,20));
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status,200);
    c.child.kill('SIGTERM');const exit=await c.exit;assert.equal(exit.code,0);assert.match(exit.stderr,/Cloud backup failed; local copy saved; see protected status/);assert.doesNotMatch(exit.stderr,/invalid.example.test|fixture/);
  } finally {if(c){c.child.kill();await c.exit;}await rm(dir,{recursive:true,force:true});}
});

test('server starts both existing profile collectors and retains password accounts after clean shutdown',{timeout:15000},async()=>{
 const {AccountStore}=await import('../../dist/apps/daemon/src/auth.js');
 const dir=await mkdtemp(join(tmpdir(),'sp-server-profiles-')),port=await freePort();let c;
 try {
  const accounts=new AccountStore(join(dir,'data.sqlite'));
  try {for(const profile of ['ruslan','gulnaz'])await accounts.createUser(profile,profile,profile,'profile-fixture-password');}finally{accounts.close();}
  c=start(dir,port);await c.ready();assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status,200);
  c.child.kill('SIGTERM');assert.equal((await c.exit).code,0);
  const reopened=new AccountStore(join(dir,'data.sqlite'));try{assert.equal(reopened.users().length,2);}finally{reopened.close();}
 }finally{if(c){c.child.kill();await c.exit;}await rm(dir,{recursive:true,force:true});}
});

test('startup backup failure with no remote settings remains private and leaves health available',{timeout:10000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-server-backup-failure-')),port=await freePort();let c;
 try {
  c=start(dir,port,{STREAM_PANEL_BACKUP_KEY_FILE:join(dir,'missing-private-key')});await c.ready();
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status,200);
  c.child.kill('SIGTERM');const result=await c.exit;assert.equal(result.code,0);assert.match(result.stderr,/Backup failed; see protected status/);assert.doesNotMatch(result.stderr,/missing-private-key/);
 }finally{if(c){c.child.kill();await c.exit;}await rm(dir,{recursive:true,force:true});}
});

test('an unreadable maintenance state fails closed instead of starting collectors',{timeout:10000},async()=>{
 const {symlink}=await import('node:fs/promises');
 const dir=await mkdtemp(join(tmpdir(),'sp-server-maintenance-error-')),port=await freePort();let c;
 try {
  await symlink('deploying',join(dir,'deploying'));
  c=start(dir,port);await c.ready();assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status,200);
  c.child.kill('SIGTERM');const result=await c.exit;assert.equal(result.code,0);assert.match(result.stderr,/Maintenance state unavailable; collectors remain stopped/);
 }finally{if(c){c.child.kill();await c.exit;}await rm(dir,{recursive:true,force:true});}
});

test('local preview imports legacy credentials/history, requires setup password and persists login across upgrades',{timeout:30000},async()=>{
 const {mkdir,writeFile,readFile}=await import('node:fs/promises');const {StreamStore}=await import('../../dist/packages/core/src/store.js');
 const root=await mkdtemp(join(tmpdir(),'sp-local-cli-')),legacy=join(root,'old'),dir=join(root,'new'),port=await freePort();await mkdir(legacy);
 const store=new StreamStore(join(legacy,'data.sqlite'));store.startSession('owner','old-stream',Date.now()-60000,'platform',Date.now()-60000);store.close();
 await writeFile(join(legacy,'secrets.json'),JSON.stringify({version:1,twitchClientId:'old-client',daClientId:'old-da',daClientSecret:'fixture'}));
 const run=(password,browser='1')=>{const c=spawn(process.execPath,['dist/apps/daemon/src/local.js'],{env:{...process.env,STREAM_PANEL_DATA_DIR:dir,STREAM_PANEL_LEGACY_DIR:legacy,STREAM_PANEL_PORT:String(port),STREAM_PANEL_INITIAL_PASSWORD:password??'',STREAM_PANEL_NO_BROWSER:browser,...(browser==='0'?{PATH:join(root,'missing-bin')}:{})},stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);const exit=new Promise(r=>c.on('exit',code=>r({code,out,err})));return {c,exit,browserError:async()=>{const deadline=Date.now()+5000;while(!err.includes('Откройте адрес панели')){assert.ok(Date.now()<deadline,'missing desktop opener must show manual browser fallback');await new Promise(r=>setTimeout(r,10));}},ready:async()=>{const deadline=Date.now()+15000;while(!out.includes('server listening')){if(c.exitCode!==null)throw Error(err);if(Date.now()>deadline)throw Error('TIMEOUT');await new Promise(r=>setTimeout(r,10));}}};};
 const children=[];
 try{
 const bad=run();children.push(bad);assert.match((await bad.exit).err,/LOCAL_PASSWORD_REQUIRED/);
 const a=run('local-password-for-browser');children.push(a);await a.ready();
 const login=await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`,{method:'POST',headers:{Origin:`http://127.0.0.1:${port}`,'Content-Type':'application/json'},body:JSON.stringify({username:'ruslan',password:'local-password-for-browser'})});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const status=await (await fetch(`http://127.0.0.1:${port}/api/v1/status`,{headers:{Cookie:cookie}})).json();assert.equal(status.config.twitchClientId,'old-client');assert.equal(status.config.daClientId,'old-da');
 assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/v1/sessions`,{headers:{Cookie:cookie}})).json()).length,1);
 assert.ok((await readFile(join(dir,'legacy-backup/data.sqlite'))).length>0);
 a.c.kill('SIGTERM');assert.equal((await a.exit).code,0);
 const b=run(undefined,'0');children.push(b);await b.ready();await b.browserError();b.c.kill('SIGTERM');assert.equal((await b.exit).code,0);
 }finally{for(const c of children)c.c.kill();await Promise.all(children.map(c=>c.exit));await rm(root,{recursive:true,force:true});}
});
