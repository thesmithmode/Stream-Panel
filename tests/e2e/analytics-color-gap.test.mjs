import test from 'node:test';import assert from 'node:assert/strict';
import {application,seed} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';import {assertUiLayout} from '../helpers/ui-layout.mjs';
test('heatmap uses one scale across weekdays and missing viewer measurements keep continuous trends without looking like zero',{timeout:60000},async()=>{
 const a=await application();let browser;
 try{
  await seed(a);const opts={fromMs:0,toMs:Date.now(),summaryOnly:true,source:'all',category:'',timezone:'Europe/Moscow'};let data;do{data=await a.db.call('analytics',opts);}while(data.preparing);
  const cell=data.hours[0]??{};
  data.hours=[['пн',17,4.4],['вт',4,4.4],['ср',10,1],['чт',18,10]].map(([day,hour,value])=>({...cell,day,hour,sampleMinutes:60,observedKnownMinutes:60,viewerSamples:60,viewersTotal:value*60,knownViewerSamples:60,knownViewersTotal:value*60,donationTotals:{},donationsPerHourMinor:{}}));
  const stream=data.streamComparison[0],now=Date.now();data.streamComparison=Array.from({length:9},(_,i)=>({...stream,id:'gap-'+i,startedAt:now-(9-i)*86400000,categories:['Game'],viewers:{...stream.viewers,all:{...stream.viewers.all,mean:i===6?null:4.4}}}));
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
  await page.route('**/api/v1/analytics?*',route=>route.fulfill({json:data}));await goto(page,a.bootstrap());await page.getByRole('button',{name:'Аналитика',exact:true}).click();
  await page.getByRole('tab',{name:'Время',exact:true}).click();await page.getByText('Настроить карту',{exact:true}).click();await page.getByLabel('Метрика карты',{exact:true}).selectOption('viewers');
  await page.waitForFunction(()=>{const cell=prefix=>document.querySelector(`.hour-heatmap button[aria-label^="${prefix}"]`),a=cell('пн 17:00'),b=cell('ср 10:00');return a?.getAttribute('aria-label')?.includes('4.4')&&b&&getComputedStyle(a).backgroundColor!==getComputedStyle(b).backgroundColor;});
  const colors=await page.locator('.hour-heatmap').evaluate(el=>['пн 17:00','вт 4:00','ср 10:00'].map(prefix=>getComputedStyle(el.querySelector(`button[aria-label^="${prefix}"]`)).backgroundColor));
  assert.equal(colors[0],colors[1]);assert.notEqual(colors[0],colors[2]);
  await page.getByRole('tab',{name:'Динамика',exact:true}).click();const chart=page.locator('.audience-growth');assert.equal(await chart.getByRole('button',{name:'О скользящем среднем',exact:true}).count(),0);
  assert.equal(await chart.locator('g[data-missing="true"] text').textContent(),'?');assert.equal(await chart.locator('g[data-missing="true"] circle:not([fill="transparent"])').count(),0);

  for(const path of await chart.locator('svg > path').evaluateAll(paths=>paths.map(p=>p.getAttribute('d'))))assert.equal((path.match(/M/g)??[]).length,1);
  assert.equal(await chart.locator('.growth-selection .trend-legend').textContent(),'4,4');
  await chart.locator('svg g').first().click();assert.equal(await chart.locator('.growth-selection .trend-legend').textContent(),'4,4');
  for(const width of [390,1280]){await page.setViewportSize({width,height:844});await assertUiLayout(page);}
  assert.equal(await page.title(),'Stream Panel');assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
