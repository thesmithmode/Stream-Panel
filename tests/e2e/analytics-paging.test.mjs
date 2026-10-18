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
 try{
  await goto(page,origin);assert.ok(await page.title());await page.getByLabel('Логин',{exact:true}).fill('fixture');await page.getByLabel('Пароль',{exact:true}).fill('fixture-paging-password');await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('button',{name:'Аналитика',exact:true}).click();
  const audience=page.getByRole('heading',{name:'Возвращаемость участников',exact:true}).locator('../..');
  await audience.getByRole('button',{name:'Следующие участники',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelectorAll('.compact-audience-table tbody tr').length===100);
  await audience.getByRole('button',{name:'Следующие участники',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.compact-audience-table tbody tr').length===25);
  await audience.getByRole('button',{name:'Предыдущие участники',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.compact-audience-table tbody tr').length===100);
  await page.getByLabel('Поиск участника').fill('viewer124');await page.waitForFunction(()=>document.querySelectorAll('.compact-audience-table tbody tr').length===1);assert.equal(await audience.getByRole('button',{name:'viewer124',exact:true}).count(),1);
  await audience.getByLabel('Сортировка').selectOption('messages');await page.getByLabel('Только ядро',{exact:true}).check();await page.waitForFunction(()=>document.querySelectorAll('.compact-audience-table tbody tr').length===0);await page.getByLabel('Только ядро',{exact:true}).uncheck();await page.getByLabel('Поиск участника').fill('');await page.waitForFunction(()=>document.querySelectorAll('.compact-audience-table tbody tr').length===100);
  const clock=page.locator('.activity-clock');await clock.locator('svg g').filter({hasNot:page.locator('title:has-text("нет данных")')}).first().click();await page.waitForFunction(()=>document.querySelectorAll('.time-audience tbody tr').length===100);
  await clock.getByRole('button',{name:'Следующие в интервале',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.time-audience tbody tr').length===25);
  await clock.getByRole('button',{name:'Предыдущие в интервале',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.time-audience tbody tr').length===100);
  let fault=true;
  await page.route('**/api/v1/analytics?*',route=>{if(fault&&new URL(route.request().url()).searchParams.has('clockMinute')){fault=false;return route.fulfill({status:400,json:{error:'CLOCK_UNAVAILABLE'}});}return route.continue();});
  await clock.locator('svg g').filter({hasNot:page.locator('title:has-text("нет данных")')}).nth(1).click();await clock.getByRole('alert').filter({hasText:'CLOCK_UNAVAILABLE'}).waitFor();await page.unroute('**/api/v1/analytics?*');
  let preparing=true;
  await page.route('**/api/v1/analytics?*',route=>{if(preparing&&new URL(route.request().url()).searchParams.has('clockMinute')){preparing=false;return route.fulfill({json:{preparing:true}});}return route.continue();});
  await clock.locator('svg g').filter({hasNot:page.locator('title:has-text("нет данных")')}).first().click();await page.waitForFunction(()=>document.querySelectorAll('.time-audience tbody tr').length===100);await page.unroute('**/api/v1/analytics?*');
  for(const width of [1280,390,320]){await page.setViewportSize({width,height:900});await assertUiLayout(page);}
  if(process.env.STREAM_PANEL_QA_DIR){await mkdir(process.env.STREAM_PANEL_QA_DIR,{recursive:true});await clock.scrollIntoViewIfNeeded();await page.screenshot({path:join(process.env.STREAM_PANEL_QA_DIR,'analytics-paging-320.png')});}
  assert.deepEqual(errors,[]);assert.ok(page.url().startsWith(origin));
 }finally{await saveCoverage(page);await context.close();await browser.close();await h.app.close();await rm(dir,{recursive:true,force:true});}
});
