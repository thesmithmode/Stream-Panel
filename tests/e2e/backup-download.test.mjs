import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {createHostedApplication} from '../../dist/apps/daemon/src/hosted.js';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,startCoverage,saveCoverage} from '../helpers/browser-coverage.mjs';

test('authenticated backup UI lists server files, separates cloud status and downloads encrypted bytes on mobile',{timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-backup-ui-')),key=join(dir,'key');await writeFile(key,'b'.repeat(64));
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const origin=`http://127.0.0.1:${port}`,h=await createHostedApplication(dir,origin,false,{keyFile:key});let browser;
 try {
  await h.accounts.createUser('ruslan','ruslan','Руслан','backup-download-password');await h.app.listen({host:'127.0.0.1',port});
  const {filename}=await h.backup.run();h.backup.status.cloud={state:'error',lastSuccessAt:0,filename:'',error:'BACKUP_UPLOAD_FAILED'};
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844},acceptDownloads:true});page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await startCoverage(page);await goto(page,origin);
  await page.getByLabel('Логин',{exact:true}).fill('ruslan');await page.getByLabel('Пароль',{exact:true}).fill('backup-download-password');await page.getByRole('button',{name:'Войти',exact:true}).click();
  await page.getByRole('button',{name:'Интеграции',exact:true}).click();
  const region=page.getByLabel('Файлы резервных копий');await region.getByText(filename,{exact:true}).waitFor();
  assert.equal(await region.getByText(join(dir,'backups'),{exact:true}).count(),1);
  assert.equal(await region.getByText('Сохранена',{exact:true}).count(),1);assert.equal(await region.getByText('Ошибка',{exact:true}).count(),1);
  const pending=page.waitForEvent('download');await region.getByRole('link',{name:'Скачать копию',exact:true}).click();const download=await pending;
  assert.equal(download.suggestedFilename(),filename);assert.equal(await download.failure(),null);
  const bytes=await readFile(await download.path());assert.equal(bytes.subarray(0,5).toString(),'SPBK1');assert.deepEqual(bytes,await h.backup.file(filename));
  await region.getByRole('button',{name:'Обновить список копий',exact:true}).click();await region.getByText(filename,{exact:true}).waitFor();
  await page.route('**/api/v1/backups',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'BACKUP_NOT_CONFIGURED'})}));
  await region.getByRole('button',{name:'Обновить список копий',exact:true}).click();await region.getByRole('alert').filter({hasText:'не настроено'}).waitFor();
  await page.unroute('**/api/v1/backups');await region.getByRole('button',{name:'Обновить список копий',exact:true}).click();await region.getByRole('alert').waitFor({state:'detached'});
  await page.screenshot({path:'/tmp/sp-backup-mobile.png',fullPage:true});await page.setViewportSize({width:1280,height:800});await page.screenshot({path:'/tmp/sp-backup-desktop.png',fullPage:true});
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await h.app.close();await rm(dir,{recursive:true,force:true});}
});
