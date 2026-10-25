import {navigate} from '../helpers/navigation.mjs';
import {refreshData} from '../helpers/navigation.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {application,seed} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
test('overview retains totals during network loss, reports real read errors and skips hidden polling',{timeout:45000},async()=>{
 const app=await application();let browser;try{
  await seed(app);browser=await launchBrowser();const page=await browser.newPage();page.setDefaultTimeout(5000);await goto(page,app.bootstrap());await navigate(page,'Обзор');await page.locator('.channel-metrics').waitFor();
  await page.route('**/api/v1/overview',route=>route.fulfill({status:500,json:{error:'SUMMARY_UNAVAILABLE'}}));await refreshData(page);await page.getByRole('alert').filter({hasText:'SUMMARY_UNAVAILABLE'}).waitFor();assert.equal(await page.locator('.channel-metrics').getByText('Сообщения',{exact:true}).locator('..').locator('strong').textContent(),'8');
  await page.unroute('**/api/v1/overview');await refreshData(page);await page.getByRole('alert').waitFor({state:'detached'});
  await page.route('**/api/v1/overview',route=>route.abort('internetdisconnected'));await refreshData(page);await page.waitForTimeout(1200);assert.equal(await page.getByRole('alert').count(),0);assert.equal(await page.locator('.channel-metrics').getByText('Сообщения',{exact:true}).locator('..').locator('strong').textContent(),'8');assert.equal(await page.getByText('Нет связи с сервером.',{exact:false}).count(),0);
  await page.unroute('**/api/v1/overview');const enabled=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/overview'&&r.status()===200);await refreshData(page);await enabled;await page.clock.install();let reads=0;page.on('request',r=>{if(new URL(r.url()).pathname==='/api/v1/overview')reads++;});await page.evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,get:()=>true}));await page.clock.fastForward(60000);assert.equal(reads,0);
  const restored=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/overview'&&r.status()===200);await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('online'));});await restored;assert.equal(await page.getByRole('alert').count(),0);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
test('overview records load and refresh independently of unavailable analytics reports',{timeout:45000},async()=>{
 const app=await application();let browser;try{
  await seed(app);browser=await launchBrowser();const page=await browser.newPage();page.setDefaultTimeout(8000);
  await page.route('**/api/v1/analytics?*',route=>route.fulfill({status:500,json:{error:'ANALYTICS_UNAVAILABLE'}}));await goto(page,app.bootstrap());
  const totals=page.locator('.channel-metrics'),records=page.locator('.channel-records');await totals.waitFor();
  assert.equal(await totals.getByText('Сообщения',{exact:true}).locator('..').locator('strong').textContent(),'8');
  assert.equal(await records.getByText('Сообщения',{exact:true}).locator('..').locator('strong').textContent(),'8');
  assert.equal(await page.getByRole('alert').count(),0);
  await page.route('**/api/v1/overview',async route=>{const response=await route.fetch(),data=await response.json();await route.fulfill({response,json:{...data,records:{...data.records,messages:{value:9,at:Date.now()}}}});});
  await refreshData(page);await records.getByText('Сообщения',{exact:true}).locator('..').getByText('9',{exact:true}).waitFor();
  assert.equal(await totals.getByText('Сообщения',{exact:true}).locator('..').locator('strong').textContent(),'8');await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
