import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
test('fresh local installation accepts its setup password in the actual browser and recovery survives restart',{timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'sp-local-browser-')),dir=join(root,'data'),browser=await launchBrowser();let child;
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));const origin=`http://127.0.0.1:${port}`;
 const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(5000);
 const env={...process.env,STREAM_PANEL_DATA_DIR:dir,STREAM_PANEL_LEGACY_DIR:join(root,'missing'),STREAM_PANEL_PORT:String(port),STREAM_PANEL_NO_BROWSER:'1',STREAM_PANEL_INITIAL_PASSWORD:'initial-browser-password'};
 const start=()=>{let out='',err='';const c=spawn(process.execPath,['dist/apps/daemon/src/local.js'],{env,stdio:['ignore','pipe','pipe']});c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);const exit=new Promise(r=>c.once('exit',r));return {c,exit,ready:async()=>{const until=Date.now()+15000;while(!out.includes('server listening')){assert.equal(c.exitCode,null,err);assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,10));}}};};
 try{
 child=start();await child.ready();await goto(page,origin);await page.getByRole('heading',{name:'Вход в Stream Panel',exact:true}).waitFor();
 assert.equal(await page.getByLabel('Логин',{exact:true}).inputValue(),'ruslan');
 await page.getByLabel('Пароль',{exact:true}).fill('bad');await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByText('Неверный логин или пароль',{exact:true}).waitFor();
 await page.getByLabel('Логин',{exact:true}).fill(' ruslan ');await page.getByLabel('Пароль',{exact:true}).fill('initial-browser-password');await page.getByRole('button',{name:'Войти',exact:true}).click();
 await page.getByRole('button',{name:'Выйти',exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'Вход в Stream Panel',exact:true}).count(),0);
 assert.ok((await context.cookies()).some(c=>c.name==='sp_session'));
 await saveCoverage(page);child.c.kill('SIGTERM');assert.equal(await child.exit,0);
 const reset=spawn(process.execPath,['dist/apps/daemon/src/password.js'],{env:{...env,STREAM_PANEL_RESET_PASSWORD:'1',STREAM_PANEL_INITIAL_PASSWORD:'replacement-browser-password'},stdio:'ignore'});assert.equal(await new Promise(r=>reset.once('exit',r)),0);
 delete env.STREAM_PANEL_INITIAL_PASSWORD;child=start();await child.ready();await goto(page,origin);await page.getByRole('heading',{name:'Вход в Stream Panel',exact:true}).waitFor();
 await page.getByLabel('Пароль',{exact:true}).fill('replacement-browser-password');await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('button',{name:'Выйти',exact:true}).waitFor();await saveCoverage(page);
 }finally{if(child){child.c.kill('SIGTERM');await child.exit;}await context.close();await browser.close();await rm(root,{recursive:true,force:true});}
});
