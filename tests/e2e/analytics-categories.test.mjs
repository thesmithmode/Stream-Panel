import test from 'node:test';
import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {assertUiLayout} from '../helpers/ui-layout.mjs';

test('every chart category selector refreshes donations, time patterns and clock data, including cached switches',{timeout:90000},async()=>{
 const a=await application();let browser;
 try{
  const base=Math.floor((Date.now()-86400000)/3600000)*3600000,minute=60000;
  const sid=await a.db.call('startSession','channel','category-check',base,'platform',base);
  await a.db.call('streamSample',sid,base,'game','Game','Game',2);
  await a.db.call('streamSample',sid,base+10*minute,'talk','Talk','Talk',8);
  for(const [id,at] of [['one',base+minute],['two',base+11*minute],['three',base+12*minute]])await a.db.call('ingest',{source:'donationalerts',accountId:'da',externalId:id,type:'donation',actor:{externalId:'name:supporter',displayName:'Supporter'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'rest',payload:{amountMinor:'10000',currency:'RUB'}});
  await a.db.call('streamSample',sid,base+20*minute,'509658','IRL','IRL',null);
  await a.db.call('endSession',sid,base+30*minute);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await goto(page,a.bootstrap());await page.getByRole('button',{name:'Аналитика',exact:true}).click();
  await page.locator('.donation-patterns header').getByText('3 донатов',{exact:true}).waitFor();
  let release;let entered;
  const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  await page.route('**/api/v1/analytics?*',async route=>{if(new URL(route.request().url()).searchParams.get('category')==='509658'){entered();await gate;}await route.continue();});
  await page.getByLabel('Категория донатов',{exact:true}).selectOption('509658');await waiting;
  assert.equal(await page.locator('.activity-clock .clock-plot').isVisible(),false);
  assert.equal(await page.locator('.time-patterns .pattern-bars').isVisible(),false);
  assert.equal(await page.locator('.donation-patterns .bars').isVisible(),false);
  release();await page.locator('.donation-patterns header').getByText('0 донатов',{exact:true}).waitFor();await page.unroute('**/api/v1/analytics?*');
  let unfiltered;
  // A cold category can first return progress with placeholder totals. Wait for
  // the completed report, just as the UI does, before checking its numbers.
  let progressSent=false;
  await page.route('**/api/v1/analytics?*',async route=>{
   if(!progressSent&&new URL(route.request().url()).searchParams.get('category')==='game'){
    progressSent=true;const response=await route.fetch(),data=await response.json();
    await route.fulfill({response,json:{...data,preparing:true,ready:0,total:1,donationTiming:{...data.donationTiming,count:0}}});
   }else await route.continue();
  });
  const selects=['Категория донатов','Категория времени эфиров','Категория карты активности','Категория суточного графика','Категория состава аудитории','Категория: Возвращаемость по эфирам','Категория: Активность чата по категориям','Категория динамики'];
  for(const selector of selects){
   for(const [category,count,mean] of [['game',1,'2'],['talk',2,'8'],['',3,'5'],['509658',0,null]]){
    const response=page.waitForResponse(async r=>{const u=new URL(r.url());return u.pathname==='/api/v1/analytics'&&u.searchParams.get('category')===category&&r.status()===200&&!(await r.json()).preparing;});
    await page.getByLabel(selector,{exact:true}).selectOption(category);const data=await (await response).json();
    assert.equal(data.filters.category,category);assert.equal(data.donationTiming.count,count);if(category==='')unfiltered=data;
    await page.locator('.donation-patterns header').getByText(`${count} донатов`,{exact:true}).waitFor();
    if(mean===null){
     await page.waitForFunction(()=>[...document.querySelectorAll('.time-patterns .pattern-row strong')].every(el=>el.textContent==='Нет данных'));
     assert.ok((await page.locator('.activity-clock svg g').evaluateAll(bars=>bars.map(b=>b.getAttribute('aria-label')))).every(label=>label.includes('нет данных')));
    }else await page.waitForFunction(expected=>[...document.querySelectorAll('.time-patterns .pattern-row strong')].some(el=>el.textContent===expected),mean);
    for(const other of selects)assert.equal(await page.getByLabel(other,{exact:true}).inputValue(),category);
   }
  }
  assert.equal(progressSent,true);await page.unroute('**/api/v1/analytics?*');
  let releaseOld,startedOld;
  const oldWaiting=new Promise(resolve=>startedOld=resolve),oldGate=new Promise(resolve=>releaseOld=resolve);
  await page.route('**/api/v1/analytics?*',async route=>{if(new URL(route.request().url()).searchParams.get('category')==='game'){startedOld();await oldGate;}await route.continue().catch(error=>{if(!route.request().failure())throw error;});});
  const oldAborted=page.waitForEvent('requestfailed',{predicate:r=>new URL(r.url()).searchParams.get('category')==='game'});
  await page.getByLabel('Категория донатов',{exact:true}).selectOption('game');await oldWaiting;
  await page.getByLabel('Категория донатов',{exact:true}).selectOption('talk');
  await page.locator('.donation-patterns header').getByText('2 донатов',{exact:true}).waitFor();releaseOld();assert.match((await oldAborted).failure().errorText,/abort|cancel|ERR_FAILED/i);await page.unroute('**/api/v1/analytics?*');
  await page.route('**/api/v1/analytics?*',route=>new URL(route.request().url()).searchParams.get('category')==='509658'?route.fulfill({json:unfiltered}):route.continue());
  await page.getByLabel('Категория донатов',{exact:true}).selectOption('509658');
  await page.locator('.donation-patterns .chart-refresh').filter({hasText:'Сервер вернул данные для других фильтров'}).waitFor();assert.equal(await page.locator('.activity-clock .clock-plot').isVisible(),false);
  await page.unroute('**/api/v1/analytics?*');await page.getByLabel('Категория донатов',{exact:true}).selectOption('talk');
  await page.locator('.donation-patterns header').getByText('2 донатов',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Категория Twitch').inputValue(),'talk');
  await page.route('**/api/v1/analytics?*',route=>new URL(route.request().url()).searchParams.get('category')==='game'?route.fulfill({status:503,json:{}}):route.continue());
  await page.getByLabel('Категория донатов',{exact:true}).selectOption('game');
  await page.locator('.donation-patterns .chart-refresh').filter({hasText:'Обновляем данные…'}).waitFor();
  await page.locator('.donation-patterns .chart-refresh').filter({hasText:'Прежние данные скрыты.'}).waitFor();
  await page.unroute('**/api/v1/analytics?*');await page.getByLabel('Категория донатов',{exact:true}).selectOption('talk');
  await page.locator('.chart-refresh').first().waitFor({state:'detached'});
  const clock=page.locator('.activity-clock');await clock.getByLabel('Метрика графика').selectOption('donations');await clock.getByLabel('Шаг графика').selectOption('60');
  assert.equal(await clock.getByLabel('Час для детализации').count(),0);
  assert.ok(await clock.locator('.value-tick').count()>=3);assert.ok(await clock.locator('.value-grid').count()>=3);assert.equal(await clock.locator('.time-grid').count(),7);
  assert.ok((await clock.locator('svg g').allTextContents()).some(text=>text.includes('1 200 RUB/ч')));
  for(const width of [1280,390]){await page.setViewportSize({width,height:900});await assertUiLayout(page);if(process.env.STREAM_PANEL_QA_SHOTS)await page.locator('.activity-clock').screenshot({path:`${process.env.STREAM_PANEL_QA_SHOTS}/activity-${width}.png`});}
  assert.equal(await page.title(),'Stream Panel');assert.ok(await page.locator('main').innerText());assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
