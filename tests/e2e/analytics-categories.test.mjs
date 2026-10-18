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
  for(const [id,at] of [['one',base+minute],['two',base+11*minute],['three',base+12*minute]])await a.db.call('ingest',{source:'donationalerts',accountId:'da',externalId:id,type:'donation',actor:{externalId:'name:supporter',displayName:'Supporter'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'rest',payload:{amountMinor:'100',currency:'RUB'}});
  await a.db.call('endSession',sid,base+20*minute);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await goto(page,a.bootstrap());await page.getByRole('button',{name:'Аналитика',exact:true}).click();
  await page.locator('.donation-patterns header').getByText('3 донатов',{exact:true}).waitFor();
  const selects=['Категория донатов','Категория времени эфиров','Категория карты активности','Категория суточного графика','Категория состава аудитории','Категория: Возвращаемость по эфирам','Категория: Активность чата по категориям','Категория динамики'];
  for(const selector of selects){
   for(const [category,count,mean] of [['game',1,'2'],['talk',2,'8'],['',3,'5']]){
    const response=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/api/v1/analytics'&&u.searchParams.get('category')===category&&r.status()===200;});
    await page.getByLabel(selector,{exact:true}).selectOption(category);const data=await (await response).json();
    assert.equal(data.filters.category,category);assert.equal(data.donationTiming.count,count);
    await page.locator('.donation-patterns header').getByText(`${count} донатов`,{exact:true}).waitFor();
    await page.waitForFunction(expected=>[...document.querySelectorAll('.time-patterns .pattern-row strong')].some(el=>el.textContent===expected),mean);
    for(const other of selects)assert.equal(await page.getByLabel(other,{exact:true}).inputValue(),category);
   }
  }
  await page.getByLabel('Категория донатов',{exact:true}).selectOption('game');
  await page.getByLabel('Категория донатов',{exact:true}).selectOption('talk');
  await page.locator('.donation-patterns header').getByText('2 донатов',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Категория Twitch').inputValue(),'talk');
  await page.route('**/api/v1/analytics?*',route=>new URL(route.request().url()).searchParams.get('category')==='game'?route.fulfill({status:503,json:{}}):route.continue());
  await page.getByLabel('Категория донатов',{exact:true}).selectOption('game');
  await page.locator('.donation-patterns .chart-refresh').filter({hasText:'Обновляем данные…'}).waitFor();
  await page.locator('.donation-patterns .chart-refresh').filter({hasText:'Показаны прежние данные.'}).waitFor();
  await page.unroute('**/api/v1/analytics?*');await page.getByLabel('Категория донатов',{exact:true}).selectOption('talk');
  await page.locator('.chart-refresh').first().waitFor({state:'detached'});
  for(const width of [1280,390]){await page.setViewportSize({width,height:900});await assertUiLayout(page);if(process.env.STREAM_PANEL_QA_SHOTS)await page.locator('.activity-clock').screenshot({path:`${process.env.STREAM_PANEL_QA_SHOTS}/activity-${width}.png`});}
  assert.equal(await page.title(),'Stream Panel');assert.ok(await page.locator('main').innerText());assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
