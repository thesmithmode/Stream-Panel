import test from 'node:test';
import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {acceptConfirmation} from '../helpers/confirmation.mjs';
test('select completed streams, cancel, merge and unmerge on mobile without losing originals',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  const at=Date.now()-6*3600000,ids=[];
  for(let n=0;n<2;n++){const start=at+n*2*3600000,id=await app.db.call('startSession','owner',`part-${n}`,start,'platform',start);ids.push(id);await app.db.call('endSession',id,start+120000);}
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(7000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await goto(page,app.bootstrap());await page.getByRole('button',{name:'Стримы',exact:true}).click();
  await page.getByRole('checkbox',{name:'Выбрать стрим',exact:true}).nth(0).check();await page.getByRole('checkbox',{name:'Выбрать стрим',exact:true}).nth(1).check();
  await page.getByRole('button',{name:'Объединить выбранные',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Отмена',exact:true}).click();assert.equal((await app.db.call('sessions')).length,2);
  await page.getByRole('button',{name:'Объединить выбранные',exact:true}).click();await acceptConfirmation(page,'Объединить');
  await page.getByRole('button',{name:'Разъединить',exact:true}).waitFor();assert.equal((await app.db.call('sessions')).length,1);
  for(const width of [390,1280]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  await page.getByRole('button',{name:'Разъединить',exact:true}).click();await acceptConfirmation(page,'Разъединить');
  await page.getByRole('checkbox',{name:'Выбрать стрим',exact:true}).nth(1).waitFor();assert.equal((await app.db.call('sessions')).length,2);assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
test('a current stream is selectable, remains selected after refresh and merges into earlier parts',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  const m=60000,at=Date.now()-20*m,older=await app.db.call('startSession','owner','older',at,'platform',at);await app.db.call('endSession',older,at+10*m);
  const live=await app.db.call('startSession','owner','live',at+10*m-1000,'platform',at+10*m-1000);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(7000);await goto(page,app.bootstrap());await page.getByRole('button',{name:'Стримы',exact:true}).click();
  await page.locator(`tr[data-session-id="${live}"]`).getByRole('checkbox',{name:'Выбрать стрим',exact:true}).check();
  await page.locator(`tr[data-session-id="${older}"]`).getByRole('checkbox',{name:'Выбрать стрим',exact:true}).check();
  await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await page.getByText('Выбрано: 2',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Объединить выбранные',exact:true}).click();await acceptConfirmation(page,'Объединить');
  await page.getByText('Объединено частей: 2',{exact:true}).waitFor();const rows=await app.db.call('sessions');assert.equal(rows.length,1);assert.equal(rows[0].ended_at_ms,null);assert.equal((await app.db.call('activeLogicalStream')).id,live);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.getByRole('button',{name:'Разъединить',exact:true}).click();await acceptConfirmation(page,'Разъединить');await page.locator(`tr[data-session-id="${live}"]`).waitFor();assert.equal((await app.db.call('sessions')).length,2);assert.equal((await app.db.call('activeLogicalStream')).id,live);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
