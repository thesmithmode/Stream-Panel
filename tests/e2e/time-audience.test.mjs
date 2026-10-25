import {clockSettings} from '../helpers/navigation.mjs';
import {assertUiLayout} from '../helpers/ui-layout.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {application} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';import {mkdir} from 'node:fs/promises';import {join} from 'node:path';
test('time audience drills from hour to minute, donors use common periods and platform colors, and all-donation patterns replace leader lists',{timeout:60000},async()=>{
 const a=await application();let browser;try{
  const day=86400000,m=60000,base=Math.floor((Date.now()-4*day)/day)*day+10*3600000;
  for(let n=0;n<3;n++){
   const start=base+n*day,id=await a.db.call('observePlatformStream','twitch','owner',`stream-${n}`,start,start,null,'Stream');
   for(const [externalId,name] of [['a','Always'],...(n===0?[['b','Sometimes']]:[])])await a.db.call('ingest',{source:'twitch',accountId:'owner',externalId:`chat-${externalId}-${n}`,type:'chat.message',actor:{externalId,displayName:name},occurredAtMs:start+m,receivedAtMs:start+m,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'Hi'}});
   await a.db.call('recordPoll',id,'owner',{startedAtMs:start,completedAtMs:start+10*m,status:'complete',userIds:['a',...(n===0?['b']:[])]});await a.db.call('endSession',id,start+10*m);
  }
  const empty=await a.db.call('startSession','owner','empty',base+3600000,'platform',base+3600000);await a.db.call('endSession',empty,base+3600000+5*m);
  await a.db.call('youtubeMessages','yt','chat',[{id:'yt',snippet:{type:'textMessageEvent',publishedAt:new Date(base).toISOString(),displayMessage:'YT'},authorDetails:{channelId:'only-yt',displayName:'YouTube Only'}}]);
  for(const [externalId,name,amount,currency,at] of [['large','Large donor','50000','RUB',base],['small1','Small donor','100','RUB',base],['small2','Small donor','100','RUB',base],['old','Old donor','99900','RUB',Date.now()-20*day],['eur','Euro donor','1000','EUR',base]])await a.db.call('ingest',{source:'donationalerts',accountId:'da',externalId,type:'donation',actor:{externalId:`name:${name.toLowerCase()}`,displayName:name},occurredAtMs:at,receivedAtMs:Date.now(),sourceTime:null,timeQuality:'provider',transport:'rest',payload:{amountMinor:amount,currency}});
  await a.db.call('ingest',{source:'donationalerts',accountId:'da',externalId:'untimed',type:'donation',actor:{externalId:'name:unknown donor',displayName:'Unknown donor'},occurredAtMs:null,receivedAtMs:Date.now(),sourceTime:null,timeQuality:'unknown',transport:'rest',payload:{amountMinor:'1',currency:'RUB'}});
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await goto(page,a.bootstrap());
  await page.getByRole('button',{name:'Люди',exact:true}).click();await page.getByRole('button',{name:'YouTube Only',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'YouTube Only',exact:true}).locator('strong').evaluate(el=>getComputedStyle(el).color),'rgb(255, 89, 89)');assert.equal(await page.getByRole('button',{name:'Always',exact:true}).locator('strong').evaluate(el=>getComputedStyle(el).color),'rgb(169, 112, 255)');
  await page.getByRole('tab',{name:'Донатеры',exact:true}).click();await page.locator('.person-row').filter({hasText:'Old donor'}).waitFor();assert.ok((await page.locator('.person-row').first().textContent()).includes('Old donor'));
  for(const p of ['7','30','all']){const response=page.waitForResponse(r=>r.url().includes('/persons/tops?'));await page.getByLabel('Период аналитики').selectOption(p);await response;await page.waitForFunction(()=>document.querySelector('.person-row'));
   if(p==='7'){await page.locator('.person-row').filter({hasText:'Large donor'}).waitFor();assert.ok((await page.locator('.person-row').first().textContent()).includes('Large donor'));}
  }
  await page.getByLabel('Валюта сортировки донатеров').selectOption('EUR');await page.locator('.person-row').filter({hasText:'Euro donor'}).waitFor();await page.waitForFunction(()=>document.querySelector('.person-row')?.textContent.includes('Euro donor'));
  await page.getByRole('button',{name:'Аналитика',exact:true}).click();await page.getByRole('tab',{name:'Время',exact:true}).click();await clockSettings(page);await page.getByRole('heading',{name:'Активность по часам',exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'Кто поддерживает стримы',exact:true}).count(),0);
  assert.deepEqual((await page.locator('.analytics-results > .panel h2').allTextContents()).slice(0,2),['Активность по дням и часам','Активность по часам']);
  await assertUiLayout(page);const chart=page.locator('.activity-clock');await chart.getByLabel('Метрика графика').selectOption('activeAudience');await chart.getByLabel('Шаг графика').selectOption('60');
  await chart.getByText('Активная аудитория · среднее · МСК',{exact:true}).waitFor();
  const averageBar=chart.getByRole('button',{name:/13:00–14:00: 1,33 активных/});await averageBar.waitFor();assert.equal(await averageBar.count(),1);
  await chart.getByRole('button',{name:/14:00–15:00: 0 активных/}).click();await chart.getByText('Персональных сигналов в этом интервале нет.',{exact:true}).waitFor();
  await averageBar.click();await chart.getByRole('cell',{name:'100%',exact:true}).waitFor();await chart.getByRole('cell',{name:'33%',exact:true}).waitFor();
  assert.equal(await chart.getByLabel('Час для детализации').count(),0);
  for(const step of ['30','15','5','1']){await chart.getByLabel('Шаг графика').selectOption(step);await chart.getByRole('button',{name:/13:00–13:/}).click();await chart.locator('tbody tr').first().waitFor();}
  for(const group of ['weekdays','weekends']){await chart.getByLabel('Дни недели').selectOption(group);assert.equal(await chart.locator('svg g').count(),1440,'day grouping preserves the full day');}
  await chart.getByLabel('Дни недели').selectOption('пн');await chart.getByLabel('Дни недели').selectOption('all');await chart.getByLabel('Шаг графика').selectOption('60');assert.equal(await chart.locator('svg g').count(),24);
  await page.locator('.donation-patterns .controls>summary').click();const donations=page.locator('.donation-patterns');for(const dim of ['weekday','hour']){await donations.getByLabel('Группировать донаты').selectOption(dim);for(const metric of ['count','amount'])await donations.getByLabel('Показатель донатов').selectOption(metric);}await donations.getByLabel('Валюта донатов').selectOption('EUR');
  assert.equal(await page.locator('.hour-table').count(),0);assert.equal(await page.locator('.heatmap-row button').count(),168);await page.getByRole('tab',{name:'Аудитория',exact:true}).click();await page.locator('.compact-audience .compact-audience-table').waitFor();await page.getByRole('tab',{name:'Время',exact:true}).click();assert.deepEqual(errors,[]);
  const evidence=process.env.STREAM_PANEL_BROWSER_COVERAGE_DIR;if(evidence){await mkdir(evidence,{recursive:true});await chart.scrollIntoViewIfNeeded();await page.screenshot({path:join(evidence,'time-audience-mobile.png'),fullPage:false});}await page.setViewportSize({width:1280,height:800});await chart.scrollIntoViewIfNeeded();await assertUiLayout(page);if(evidence)await page.screenshot({path:join(evidence,'time-audience-desktop.png'),fullPage:false});await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
