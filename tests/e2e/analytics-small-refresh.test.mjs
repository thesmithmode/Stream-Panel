import test from 'node:test';
import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
test('small-audience search and core filters remain reversible after auto-refresh',{timeout:60000},async()=>{
 const a=await application();let browser,page;
 try{
  const at=Date.now()-3600000,id=await a.db.call('startSession','owner','small-refresh',at,'platform',at);
  await a.db.call('streamSample',id,at,'game','Game','',2);
  await a.db.call('recordPoll',id,'owner',{startedAtMs:at,completedAtMs:at+59999,status:'complete',userIds:['alice','bob'],userNames:{alice:'Alice',bob:'Bob'}});
  await a.db.call('endSession',id,at+120000);
  browser=await launchBrowser();page=await browser.newPage();page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await goto(page,a.bootstrap());await page.getByRole('button',{name:'Аналитика',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.compact-audience-table tbody tr').length===2);
  const search=page.getByLabel('Поиск участника');
  await search.fill('Alice');await page.waitForFunction(()=>document.querySelectorAll('.compact-audience-table tbody tr').length===1);
  let response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/analytics');
  await page.evaluate(()=>window.dispatchEvent(new Event('sp:data-refresh')));await response;
  await page.waitForFunction(()=>!document.querySelector('.chart-refresh')?.textContent.includes('Обновляем'));
  await search.fill('');await page.waitForFunction(()=>document.querySelectorAll('.compact-audience-table tbody tr').length===2);
  await page.getByLabel('Только ядро',{exact:true}).check();await page.waitForFunction(()=>document.querySelectorAll('.compact-audience-table tbody tr').length===0);
  response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/analytics');
  await page.evaluate(()=>window.dispatchEvent(new Event('sp:data-refresh')));await response;
  await page.waitForFunction(()=>!document.querySelector('.chart-refresh')?.textContent.includes('Обновляем'));
  await page.getByLabel('Только ядро',{exact:true}).uncheck();await page.waitForFunction(()=>document.querySelectorAll('.compact-audience-table tbody tr').length===2);
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
