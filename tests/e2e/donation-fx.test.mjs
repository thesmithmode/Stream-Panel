import {refreshData} from '../helpers/navigation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {assertUiLayout} from '../helpers/ui-layout.mjs';

test('foreign donation history shows original plus historical RUB on desktop and mobile; totals update after CBR backfill',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  const at=Date.now()-300000,day=new Date(at+3*3600000).toISOString().slice(0,10);
  const sid=await app.db.call('startSession','owner','fx-live',at-60000,'platform',at);
  const tip={source:'donationalerts',accountId:'da',externalId:'fx',type:'donation',actor:{externalId:'name:currency donor',displayName:'Currency donor'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'rest',payload:{actorName:'Currency donor',text:'Спасибо за стрим',amountMinor:'250',currency:'USD'}};
  const person=(await app.db.call('ingest',tip)).personId;
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await goto(page,app.bootstrap());assert.equal(new URL(page.url()).origin,app.origin);assert.ok(await page.title());
  await page.getByText(/Донаты без пересчёта: 1\./).waitFor();
  await page.getByRole('button',{name:'Стримы',exact:true}).click();await page.locator(`[data-session-id="${sid}"] .stream-open`).click();
  const donations=page.getByRole('region',{name:'Донаты стрима'});
  await donations.getByText('2,50 USD (пересчёт в RUB ожидается)',{exact:true}).waitFor();
  await app.db.call('saveExchangeRates',day,day,[{currency:'USD',value:'80.1234',nominal:1}],Date.now());
  await refreshData(page);
  const expected=`2,50 USD (200,31 RUB · ЦБ на ${day.split('-').reverse().join('.')})`;
  await donations.getByText(expected,{exact:true}).waitFor();
  assert.equal((await app.db.call('summary',sid)).totals.RUB,'20031');await page.locator('.stream-kpis').getByText('200,31 RUB',{exact:true}).waitFor();
  for(const width of [1280,390,320]){await page.setViewportSize({width,height:900});await donations.scrollIntoViewIfNeeded();await assertUiLayout(page);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'foreign amount must wrap inside viewport');assert.ok(await donations.locator('.donation-owner').evaluate(el=>el.getBoundingClientRect().height<60),'donor name must remain readable');}
  await page.setViewportSize({width:1280,height:900});await donations.evaluate(el=>el.scrollIntoView({block:'start'}));await page.screenshot({path:'/tmp/sp-fx-desktop.png',fullPage:false});
  await page.setViewportSize({width:390,height:844});await donations.evaluate(el=>el.scrollIntoView({block:'start'}));await page.screenshot({path:'/tmp/sp-fx-mobile.png',fullPage:false});
  await donations.getByRole('button',{name:'Связан: Currency donor',exact:true}).click();await page.getByRole('tab',{name:'Донаты',exact:true}).click();
  await page.getByRole('region',{name:'Донаты человека'}).getByText(expected,{exact:true}).waitFor();
  assert.equal((await app.db.call('personStats',person)).donationTotals.RUB,'20031');
  await page.getByRole('button',{name:'Обзор',exact:true}).click();await page.getByText('Сумма донатов · RUB',{exact:true}).locator('..').getByText('200,31 RUB',{exact:true}).waitFor();assert.equal(await page.getByText(/Донаты без пересчёта: 1\./).count(),0);
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
