import test from 'node:test';import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';import {assertUiLayout} from '../helpers/ui-layout.mjs';
test('audience trend switches platforms, shows seven-stream smoothing and opens the exact broadcast',{timeout:60000},async()=>{
 const a=await application();let browser;
 try{
  const m=60000,day=86400000,base=Math.floor((Date.now()-60*day)/day)*day+7*3600000,ids=[];
  for(let n=0;n<55;n++){const at=base+n*day,id=await a.db.call('startSession','owner',`growth-${n}`,at,'platform',at);ids.push(id);await a.db.call('streamSample',id,at,'game','Game','Repeated title',n);await a.db.call('endSession',id,at+m);}
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));await goto(page,a.bootstrap());
  await page.getByRole('button',{name:'Аналитика',exact:true}).click();const chart=page.locator('.audience-growth');await chart.waitFor();assert.equal(await page.getByRole('heading',{name:'Зрители по эфирам',exact:true}).count(),0);
  assert.equal(await chart.locator('svg g').count(),50);
  await chart.getByRole('button',{name:'Раньше',exact:true}).click();assert.equal(await chart.locator('svg g').count(),5);await chart.getByRole('button',{name:'Позже',exact:true}).click();assert.equal(await chart.locator('svg g').count(),50);
  await chart.getByLabel('Источник динамики').selectOption('twitch');assert.ok((await chart.locator('svg g').nth(1).getAttribute('aria-label')).includes('среднее за 7 эфиров: 3'));
  await chart.getByLabel('Источник динамики').selectOption('youtube');assert.ok((await chart.locator('svg g').first().getAttribute('aria-label')).includes('средние зрители: нет данных'));
  await chart.getByLabel('Источник динамики').selectOption('all');await chart.locator('summary').click();assert.equal(await chart.locator('tbody tr').count(),50);assert.ok((await chart.locator('tbody tr').first().textContent()).includes('Game'));
  const clock=page.locator('.activity-clock');await clock.locator('svg g').first().focus();await page.keyboard.press(' ');await page.keyboard.press('ArrowRight');assert.ok((await clock.getByRole('status').textContent()).includes('00:00'));
  await assertUiLayout(page);await page.setViewportSize({width:1280,height:800});await assertUiLayout(page);
  await chart.locator('svg g').first().click();await page.waitForURL(url=>url.searchParams.get('stream')===ids[5]);await page.goBack();await chart.waitFor();
  await chart.locator('summary').click();await chart.locator('tbody button').first().click();await page.waitForURL(url=>url.searchParams.get('stream')===ids[5]);await page.goBack();await chart.waitFor();
  await chart.locator('svg g').nth(6).focus();await page.keyboard.press('Enter');await page.waitForURL(url=>url.searchParams.get('view')==='stream'&&url.searchParams.get('stream')===ids[11]);await page.locator('.stream-page').waitFor();assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
