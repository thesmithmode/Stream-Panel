import {clockSettings} from '../helpers/navigation.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,mkdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {AccountStore} from '../../dist/apps/daemon/src/auth.js';import {createHostedApplication} from '../../dist/apps/daemon/src/hosted.js';
import {launchBrowser} from '../helpers/browser.mjs';import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';import {assertUiLayout} from '../helpers/ui-layout.mjs';
test('large report pages, searches and clock visitor pages remain complete and responsive',{timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-analytics-paging-')),accounts=new AccountStore(join(dir,'data.sqlite'));
 await accounts.createUser('ruslan','fixture','Fixture','fixture-paging-password');accounts.close();
 const setup=await createHostedApplication(dir,'http://127.0.0.1:47831',false);await setup.app.listen({host:'127.0.0.1',port:0});const port=setup.app.server.address().port;await setup.app.close();
 const origin=`http://127.0.0.1:${port}`,h=await createHostedApplication(dir,origin,false),db=h.runtimes.get('ruslan').db;
 const base=Math.floor((Date.now()-86400000)/86400000)*86400000+10*3600000,ids=Array.from({length:125},(_,i)=>`viewer${String(i).padStart(3,'0')}`);
 for(let n=0;n<2;n++){const at=base+n*3600000,sid=await db.call('startSession','owner',String(n),at,'platform',at);await db.call('streamSample',sid,at,'game','Game','',125);await db.call('recordPoll',sid,'owner',{startedAtMs:at,completedAtMs:at+59999,status:'complete',userIds:ids,userNames:Object.fromEntries(ids.map(id=>[id,id]))});await db.call('endSession',sid,at+120000);}
 await h.app.listen({host:'127.0.0.1',port});const browser=await launchBrowser(),context=await browser.newContext(),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(8000);
 const reportRequests=[],audienceResponses=[];
 page.on('request',r=>{if(new URL(r.url()).pathname==='/api/v1/analytics')reportRequests.push(r.url());});
 page.on('response',r=>{if(new URL(r.url()).pathname==='/api/v1/analytics/audience')audienceResponses.push(r.json());});
 try{
  await goto(page,origin);assert.ok(await page.title());await page.getByLabel('Логин',{exact:true}).fill('fixture');await page.getByLabel('Пароль',{exact:true}).fill('fixture-paging-password');await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('button',{name:'Аналитика',exact:true}).click();await page.getByRole('tab',{name:'Аудитория',exact:true}).click();
  const audience=page.getByRole('heading',{name:'Возвращаемость участников',exact:true}).locator('../..');
  await audience.getByRole('button',{name:'Следующие участники',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelectorAll('.compact-audience-table tbody tr').length===100);
  const initialReports=reportRequests.length;
  await audience.getByRole('button',{name:'Следующие участники',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.compact-audience-table tbody tr').length===25);
  await audience.getByRole('button',{name:'Предыдущие участники',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.compact-audience-table tbody tr').length===100);
  await page.getByLabel('Поиск участника').fill('viewer124');await page.waitForFunction(()=>document.querySelectorAll('.compact-audience-table tbody tr').length===1);assert.equal(await audience.getByRole('button',{name:'viewer124',exact:true}).count(),1);
  await audience.getByLabel('Сортировка').selectOption('messages');await page.getByLabel('Только ядро',{exact:true}).check();await page.waitForFunction(()=>document.querySelectorAll('.compact-audience-table tbody tr').length===0);await page.getByLabel('Только ядро',{exact:true}).uncheck();await page.getByLabel('Поиск участника').fill('');await page.waitForFunction(()=>document.querySelectorAll('.compact-audience-table tbody tr').length===100);
  assert.equal(reportRequests.length,initialReports,'audience paging and search must not download the full report again');
  assert.ok(audienceResponses.length>0);for(const response of await Promise.all(audienceResponses)){if(!response.preparing){assert.ok(Array.isArray(response.audience));assert.equal(response.clockBuckets,undefined);assert.equal(response.activityClock,undefined);assert.equal(response.streamComparison,undefined);}}
  await page.getByRole('tab',{name:'Время',exact:true}).click();await clockSettings(page);const clock=page.locator('.activity-clock');await clock.locator('svg g').filter({hasNot:page.locator('title:has-text("нет данных")')}).first().click();await page.waitForFunction(()=>document.querySelectorAll('.time-audience tbody tr').length===100);
  await clock.getByRole('button',{name:'Следующие в интервале',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.time-audience tbody tr').length===25);
  await clock.getByRole('button',{name:'Предыдущие в интервале',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.time-audience tbody tr').length===100);
  // An already selected interval loads its new resolution; nearby clicks share the batch.
  const batch=page.waitForResponse(r=>r.url().includes('/analytics/clock?')&&new URL(r.url()).searchParams.get('clockResolution')==='30');
  const summaryResponse=page.waitForResponse(r=>r.url().includes('/analytics/clock-summary?'));
  await clock.getByLabel('Шаг графика').selectOption('30');await summaryResponse;
  await clock.getByRole('status').filter({hasText:'Загружаем детализацию'}).waitFor({state:'hidden'});
  await clock.locator('svg g').filter({hasNot:page.locator('title:has-text("нет данных")')}).first().click();await batch;
  let clockRequests=0;const countRequests=request=>{if(request.url().includes('/analytics/clock?'))clockRequests++;};page.on('request',countRequests);
  const bars=clock.locator('svg g').filter({hasNot:page.locator('title:has-text("нет данных")')});
  for(let i=0;i<6;i++){await bars.nth(i%2).click();await page.waitForFunction(()=>document.querySelectorAll('.time-audience tbody tr').length===100);}
  assert.equal(clockRequests,0,'prepared column switches make no requests');page.off('request',countRequests);
  const fullReports=reportRequests.length;
  let summaryFault=true;
  await page.route('**/api/v1/analytics/clock-summary?*',route=>{if(summaryFault){summaryFault=false;return route.fulfill({status:400,json:{error:'SUMMARY_UNAVAILABLE'}});}return route.continue();});
  await clock.getByLabel('Шаг графика').selectOption('5');await clock.getByRole('alert').filter({hasText:'SUMMARY_UNAVAILABLE'}).waitFor();
  await clock.getByRole('button',{name:'Повторить',exact:true}).click();await clock.getByRole('status').filter({hasText:'Загружаем детализацию'}).waitFor({state:'hidden'});await page.unroute('**/api/v1/analytics/clock-summary?*');
  let summaries=0;const countSummaries=r=>{if(r.url().includes('/analytics/clock-summary?'))summaries++;};page.on('request',countSummaries);
  await clock.getByLabel('Шаг графика').selectOption('30');await clock.getByLabel('Шаг графика').selectOption('5');assert.equal(summaries,0,'already loaded resolutions are retained');page.off('request',countSummaries);
  await clock.getByLabel('Шаг графика').selectOption('30');
  await clock.locator('svg g').filter({hasNot:page.locator('title:has-text("нет данных")')}).first().click();await page.waitForFunction(()=>document.querySelectorAll('.time-audience tbody tr').length===100);
  assert.equal(reportRequests.length,fullReports,'clock changes do not reload the report');
  let fault=true;
  await page.route('**/api/v1/analytics/clock?*',route=>{if(fault&&new URL(route.request().url()).searchParams.get('clockOffset')==='100'){fault=false;return route.fulfill({status:400,json:{error:'CLOCK_UNAVAILABLE'}});}return route.continue();});
  await clock.getByRole('button',{name:'Следующие в интервале',exact:true}).click();await clock.getByRole('alert').filter({hasText:'CLOCK_UNAVAILABLE'}).waitFor();assert.equal(await clock.locator('.clock-plot').isVisible(),true);await page.unroute('**/api/v1/analytics/clock?*');
  await clock.getByRole('button',{name:'Предыдущие в интервале',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.time-audience tbody tr').length===100);
  let preparing=true;
  await page.route('**/api/v1/analytics/clock?*',route=>{if(preparing&&new URL(route.request().url()).searchParams.get('clockOffset')==='100'){preparing=false;return route.fulfill({json:{preparing:true}});}return route.continue();});
  await clock.getByRole('button',{name:'Следующие в интервале',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.time-audience tbody tr').length===25);await page.unroute('**/api/v1/analytics/clock?*');
  // Auto-refresh updates values without hiding plots, replacing rows or resetting page two.
  await clock.scrollIntoViewIfNeeded();const scroll=await page.evaluate(()=>scrollY);await page.evaluate(()=>{window.clockNode=document.querySelector('.clock-plot');window.visitorNode=document.querySelector('.time-audience tbody tr');});
  let entered,release;const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  await page.route('**/api/v1/analytics?*',async route=>{entered();await gate;return route.continue();});
  await page.evaluate(()=>window.dispatchEvent(new Event('sp:data-refresh')));await waiting;
  assert.equal(await clock.locator('.clock-plot').isVisible(),true);assert.equal(await clock.locator('.time-audience').isVisible(),true);
  const refreshed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/analytics');release();await refreshed;await page.unroute('**/api/v1/analytics?*');
  await page.waitForFunction(()=>document.querySelector('.analytics-results')?.getAttribute('aria-busy')==='false');
  assert.equal(await page.evaluate(()=>window.clockNode===document.querySelector('.clock-plot')),true);assert.equal(await page.evaluate(()=>window.visitorNode===document.querySelector('.time-audience tbody tr')),true);
  assert.equal(await clock.locator('tbody tr').count(),25);assert.ok(Math.abs((await page.evaluate(()=>scrollY))-scroll)<5);
  const minuteCells=await audience.locator('tbody tr td:nth-child(3)').allTextContents();assert.ok(minuteCells.every(text=>/^[\d\s\u00a0]+$/.test(text)),'minutes display whole numbers');
  for(const width of [1280,390,320]){await page.setViewportSize({width,height:900});await assertUiLayout(page);}
  if(process.env.STREAM_PANEL_QA_DIR){await mkdir(process.env.STREAM_PANEL_QA_DIR,{recursive:true});await clock.scrollIntoViewIfNeeded();await page.screenshot({path:join(process.env.STREAM_PANEL_QA_DIR,'analytics-paging-320.png')});}
  assert.deepEqual(errors,[]);assert.ok(page.url().startsWith(origin));
 }finally{await saveCoverage(page);await context.close();await browser.close();await h.app.close();await rm(dir,{recursive:true,force:true});}
});
