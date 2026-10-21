import {clockSettings,setFilter} from '../helpers/navigation.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';import {assertUiLayout} from '../helpers/ui-layout.mjs';
test('audience trend switches platforms, shows seven-stream smoothing and opens the exact broadcast',{timeout:60000},async()=>{
 const a=await application();let browser;
 try{
  const m=60000,day=86400000,base=Math.floor((Date.now()-60*day)/day)*day+7*3600000,ids=[];
  for(let n=0;n<55;n++){const at=base+n*day,id=await a.db.call('startSession','owner',`growth-${n}`,at,'platform',at);ids.push(id);await a.db.call('streamSample',id,at,'game','Game','Repeated title',n);await a.db.call('endSession',id,at+m);}
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));await goto(page,a.bootstrap());
  await page.getByRole('button',{name:'Аналитика',exact:true}).click();const chart=page.locator('.audience-growth');await chart.waitFor();assert.equal(await page.getByRole('heading',{name:'Зрители по эфирам',exact:true}).count(),0);
  assert.equal(await chart.locator('svg g').count(),12);
  await chart.getByRole('button',{name:'Раньше',exact:true}).click();assert.equal(await chart.locator('svg g').count(),12);await chart.getByRole('button',{name:'Позже',exact:true}).click();assert.equal(await chart.locator('svg g').count(),12);
  await chart.getByRole('button',{name:'Twitch',exact:true}).click();assert.ok((await chart.locator('svg g').first().getAttribute('aria-label')).includes('среднее за 7 эфиров: 40'));
  await chart.getByRole('button',{name:'YouTube',exact:true}).click();assert.ok((await chart.locator('svg g').first().getAttribute('aria-label')).includes('средние зрители: нет данных'));
  await chart.getByRole('button',{name:'Вместе',exact:true}).click();assert.equal(await chart.locator('details').count(),0);assert.equal(await chart.locator('.growth-recent button').count(),3);assert.ok((await chart.locator('.growth-recent button').first().textContent()).includes('54'));
  await chart.locator('svg g').first().click();assert.ok((await chart.locator('.growth-selection').textContent()).includes('43'));assert.ok((await chart.locator('.growth-selection').textContent()).includes('Game'));
  await page.getByRole('tab',{name:'Время',exact:true}).click();await clockSettings(page);const clock=page.locator('.activity-clock');
  await clock.getByLabel('Метрика графика').selectOption('messages');await clock.getByText('Сообщения на час эфира · Europe/Moscow',{exact:true}).waitFor();
  await setFilter(page,'Период аналитики','7');await page.getByRole('tab',{name:'Динамика',exact:true}).click();await chart.getByRole('button',{name:'О среднем за семь эфиров',exact:true}).click();await page.getByRole('dialog',{name:'О среднем за семь эфиров',exact:true}).getByText(/Нужно семь эфиров/).waitFor();await page.keyboard.press('Escape');assert.ok(await chart.locator('svg g').count()<7);assert.equal(await chart.locator('.growth-pages').count(),0);
  await setFilter(page,'Период аналитики','all');await chart.locator('svg g').nth(11).waitFor();
  await page.evaluate(()=>window.scrollTo(0,0));await assertUiLayout(page);await chart.screenshot({path:'/tmp/analytics-growth-mobile.png'});await page.setViewportSize({width:1280,height:800});await page.evaluate(()=>window.scrollTo(0,0));await assertUiLayout(page);await chart.screenshot({path:'/tmp/analytics-growth-desktop.png'});
  await chart.locator('svg g').first().click();await chart.getByRole('button',{name:'Открыть эфир',exact:true}).click();await page.waitForURL(url=>url.searchParams.get('stream')===ids[43]);await page.goBack();await chart.waitFor();
  await chart.locator('.growth-recent button').first().click();await page.waitForURL(url=>url.searchParams.get('stream')===ids[54]);await page.goBack();await chart.waitFor();
  await chart.locator('svg g').nth(6).focus();await page.keyboard.press('Enter');assert.equal(await chart.locator('svg g').nth(6).getAttribute('aria-pressed'),'true');await page.keyboard.press(' ');await chart.getByRole('button',{name:'Открыть эфир',exact:true}).click();await page.waitForURL(url=>url.searchParams.get('view')==='stream'&&url.searchParams.get('stream')===ids[49]);await page.locator('.stream-page').waitFor();assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
