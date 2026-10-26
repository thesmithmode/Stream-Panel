import {setFilter,clockSettings} from '../helpers/navigation.mjs';
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
  await goto(page,a.bootstrap());await page.getByRole('button',{name:'Аналитика',exact:true}).click();await page.getByRole('tab',{name:'Время',exact:true}).click();
  await page.locator('.donation-patterns header').getByText('3 донатов',{exact:true}).waitFor();
  let release;let entered;
  const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  await page.route('**/api/v1/analytics?*',async route=>{if(new URL(route.request().url()).searchParams.get('category')==='509658'){entered();await gate;}await route.continue();});
  await setFilter(page,'Категория Twitch','509658');await waiting;
  assert.equal(await page.locator('.activity-clock .clock-plot').isVisible(),true);
  assert.equal(await page.locator('.time-patterns .pattern-bars').isVisible(),true);
  assert.equal(await page.locator('.donation-patterns .bars').isVisible(),true);
  release();await page.locator('.donation-patterns header').getByText('0 донатов',{exact:true}).waitFor();await page.unroute('**/api/v1/analytics?*');
  let unfiltered;do{unfiltered=await a.db.call('analytics',{fromMs:0,toMs:Date.now(),summaryOnly:true,source:'all',category:'',timezone:'Europe/Moscow'});}while(unfiltered.preparing);
  // A cold category can first return progress with placeholder totals. Wait for
  // the completed report, just as the UI does, before checking its numbers.
  let progressSent=false;
  await page.route('**/api/v1/analytics?*',async route=>{
   if(!progressSent&&new URL(route.request().url()).searchParams.get('category')==='game'){
    progressSent=true;const response=await route.fetch({headers:{...route.request().headers(),'if-none-match':''}}),data=await response.json();
    await route.fulfill({response,headers:{...response.headers(),etag:''},json:{...data,preparing:true,ready:0,total:1,donationTiming:{...data.donationTiming,count:0}}});
   }else await route.continue();
  });
  const selects=['Категория Twitch'];
  for(const selector of selects){
   for(const [category,count,mean] of [['game',1,'2'],['talk',2,'8'],['',3,'5'],['509658',0,null]]){
    await setFilter(page,selector,category);
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
  await page.clock.setFixedTime(Date.now()+120000);
  const oldCompleted=page.waitForEvent('requestfailed',{predicate:r=>new URL(r.url()).pathname==='/api/v1/analytics'&&new URL(r.url()).searchParams.get('category')==='game'});
  await setFilter(page,'Категория Twitch','game');await oldWaiting;
  await setFilter(page,'Категория Twitch','talk');
  await page.locator('.donation-patterns header').getByText('2 донатов',{exact:true}).waitFor();releaseOld();await oldCompleted;await page.locator('.donation-patterns header').getByText('2 донатов',{exact:true}).waitFor();await page.unroute('**/api/v1/analytics?*');
  await page.route('**/api/v1/analytics?*',route=>new URL(route.request().url()).searchParams.get('category')==='509658'?route.fulfill({json:unfiltered}):route.continue());
  await setFilter(page,'Категория Twitch','509658');
  await page.getByRole('alert').filter({hasText:'Сервер вернул данные для других фильтров'}).waitFor();assert.equal(await page.locator('.activity-clock .clock-plot').isVisible(),true);
  await page.unroute('**/api/v1/analytics?*');await setFilter(page,'Категория Twitch','talk');
  await page.locator('.donation-patterns header').getByText('2 донатов',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Категория Twitch').inputValue(),'talk');
  await page.clock.setFixedTime(Date.now()+240000);
  await page.route('**/api/v1/analytics?*',route=>new URL(route.request().url()).searchParams.get('category')==='game'?route.fulfill({status:503,json:{}}):route.continue());
  await setFilter(page,'Категория Twitch','game');

  await page.getByRole('alert').waitFor();
  await page.unroute('**/api/v1/analytics?*');await setFilter(page,'Категория Twitch','talk');
  await page.locator('.chart-refresh').first().waitFor({state:'detached'});
  await clockSettings(page);const clock=page.locator('.activity-clock');await clock.getByLabel('Метрика графика').selectOption('donations');await clock.getByLabel('Шаг графика').selectOption('60');
  assert.equal(await clock.getByLabel('Час для детализации').count(),0);
  assert.ok(await clock.locator('.value-tick').count()>=3);assert.ok(await clock.locator('.value-grid').count()>=3);assert.equal(await clock.locator('.time-grid').count(),7);
  await clock.locator('svg g').filter({hasText:'1 200 RUB/ч'}).first().waitFor();
  assert.ok((await clock.locator('svg g').allTextContents()).some(text=>text.includes('1 200 RUB/ч')));
  for(const width of [1280,390]){await page.setViewportSize({width,height:900});await assertUiLayout(page);if(process.env.STREAM_PANEL_QA_SHOTS)await page.locator('.activity-clock').screenshot({path:`${process.env.STREAM_PANEL_QA_SHOTS}/activity-${width}.png`});}
  assert.equal(await page.title(),'Stream Panel');assert.ok(await page.locator('main').innerText());assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
