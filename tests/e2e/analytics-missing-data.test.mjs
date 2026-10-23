import {navigate,setFilter,openFilters,closeFilters} from '../helpers/navigation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localDateWindow} from '../../dist/packages/core/src/time-audience.js';
import {AccountStore} from '../../dist/apps/daemon/src/auth.js';
import {createHostedApplication} from '../../dist/apps/daemon/src/hosted.js';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';

test('analytics keeps unknown historical signals distinct from zero and renders large audiences safely',{timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-analytics-missing-'));
 const accounts=new AccountStore(join(dir,'data.sqlite'));
 await accounts.createUser('ruslan','fixture','Fixture','fixture-missing-data-password');accounts.close();
 const h=await createHostedApplication(dir,'http://127.0.0.1:47831',false);
 // A dynamic loopback listener keeps this fixture independent of other browser tests.
 await h.app.listen({host:'127.0.0.1',port:0});
 const port=h.app.server.address().port;
 await h.app.close();
 const hosted=await createHostedApplication(dir,`http://127.0.0.1:${port}`,false);
 await hosted.app.listen({host:'127.0.0.1',port});
 const browser=await launchBrowser(),context=await browser.newContext(),page=await context.newPage();
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const now=Date.now(),person={id:'historical',name:'Исторический участник',source:'twitch',messages:0,observedMinutes:0,estimatedChatMinutes:0,sessionIds:[],intervals:[],donations:{},core:false};
 let data={summary:{entities:1,core:0,streams:1,messages:0},audience:[person],timeline:[],categories:[{id:'unknown',name:'Неизвестная категория',sessions:1,minutes:0,audience:1,core:0,messagesPerHour:0,observedMinutes:0,estimatedChatMinutes:0,observedPerKnownMinute:null,coverageRatio:null}],hours:[{day:'пн',hour:0,messages:0,sampleMinutes:0,observedKnownMinutes:0,observed:0,estimated:0,donationsPerHourMinor:{RUB:null}}],streamComparison:[{startedAt:now-60000,endedAt:now,categories:[],audience:1,core:0,returning:0,newInPeriod:0,uniqueChatters:0,peakChatters:0,meanChatters:null,viewers:{twitch:{mean:null,peak:null,coverageRatio:null},youtube:{mean:null,peak:null,coverageRatio:null}},messages:0,messagesPerHour:null,donationsPerHourMinor:{RUB:null}}],youtubeReport:{updatedAt:now,data:{start:'2026-10-01',end:'2026-10-02'}}};
 data.streamComparison.push({...data.streamComparison[0],audience:0,viewers:{all:{mean:4,peak:6},twitch:{mean:3,peak:5,coverageRatio:1},youtube:{mean:1,peak:1,coverageRatio:1}}});
 // These responses model missing historical optional fields; authentication remains real.
 await page.route('**/api/v1/analytics?*',route=>route.fulfill({json:data}));
 page.setDefaultTimeout(8000);
 const response=()=>page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/analytics');
 const renderNextHistory=async()=>{assert.deepEqual(errors,[]);await navigate(page,'Обзор');await page.getByRole('button',{name:'Аналитика',exact:true}).click();await page.locator('.analytics-results').waitFor();await page.waitForFunction(()=>document.querySelector('.analytics-results')?.getAttribute('aria-busy')==='false');const received=response();await page.evaluate(()=>window.dispatchEvent(new Event('sp:data-refresh')));await received;await page.getByRole('tab',{name:'Аудитория',exact:true}).click();};
 try {
  await goto(page,`http://127.0.0.1:${port}`);
  await page.getByLabel('Логин',{exact:true}).fill('fixture');await page.getByLabel('Пароль',{exact:true}).fill('fixture-missing-data-password');await page.getByRole('button',{name:'Войти',exact:true}).click();
  const first=response();await page.getByRole('button',{name:'Аналитика',exact:true}).click();await first;await page.getByRole('tab',{name:'Аудитория',exact:true}).click();
  await page.getByRole('button',{name:person.name,exact:true}).waitFor();
  assert.ok(await page.getByText('0 из 1 (нет данных)',{exact:true}).count());
  await page.getByRole('tab',{name:'Динамика',exact:true}).click();const legacyGrowth=page.locator('.audience-growth');await legacyGrowth.locator('svg g').first().click();await legacyGrowth.locator('svg g').first().focus();await page.keyboard.press(' ');await page.keyboard.press('ArrowRight');assert.ok(new URL(page.url()).searchParams.get('view')==='analytics');assert.equal(await legacyGrowth.locator('.growth-recent button:disabled').count(),2);assert.equal(await legacyGrowth.getByRole('button',{name:'Открыть эфир',exact:true}).isDisabled(),true);assert.equal(await legacyGrowth.getByText('Без категории',{exact:true}).count(),3);
  await setFilter(page,'Период аналитики','custom');
  const report=page.getByRole('heading',{name:'Агрегатный отчёт YouTube: все видео канала',exact:true}).locator('..').locator('..');
  assert.equal(await report.locator('th').count(),0);assert.equal(await report.locator('tbody tr').count(),0);
  await page.getByRole('tab',{name:'Время',exact:true}).click();await page.getByText('Настроить карту',{exact:true}).click();const hours=page.locator('.hour-table');await hours.locator('summary').click();
  for(const metric of ['observed','estimated','messages','viewers']){
   await page.getByLabel('Метрика карты').selectOption(metric);
   assert.equal((await hours.locator('tbody tr td').nth(1).textContent()).trim(),'нет данных');
   assert.match(await page.locator('.hour-heatmap .heatmap-row button').first().getAttribute('title'),/нет данных/);
  }
  await page.getByRole('tab',{name:'Динамика',exact:true}).click();assert.equal(await page.getByText('Таблица сравнения стримов',{exact:true}).count(),0);
  data.aggregate=true;data.timeline=[{at:localDateWindow(new Date(now).toLocaleDateString('sv-SE',{timeZone:'Europe/Moscow'}),'Europe/Moscow').from,presenceKnown:true,observed:1}];await renderNextHistory();await page.getByRole('button',{name:person.name,exact:true}).waitFor();
  await page.route('**/api/v1/analytics?*',route=>new URL(route.request().url()).searchParams.get('from')==='0'?route.fulfill({json:data}):route.fulfill({status:400,json:{error:'DETAIL_UNAVAILABLE'}}));
  await page.getByRole('button',{name:`Интервалы ${person.name}`,exact:true}).click();
  await page.getByRole('alert').filter({hasText:'DETAIL_UNAVAILABLE'}).waitFor();
  await page.getByRole('heading',{name:`Активность: ${person.name}`,exact:true}).waitFor();
  await page.locator('.minute-dot.unknown').first().waitFor();
  assert.equal(await page.locator('.minute-dot.unknown').count(),1440);
  await page.getByRole('button',{name:'Закрыть детализацию'}).click();await page.unroute('**/api/v1/analytics?*');
  await page.route('**/api/v1/analytics?*',route=>route.fulfill({json:new URL(route.request().url()).searchParams.get('from')==='0'?data:{...data,audience:[{...person,intervals:[{from:now-60000,to:now,session:'historical-session',kind:'observed'}]}]}}));
  await page.getByRole('button',{name:`Интервалы ${person.name}`,exact:true}).click();await page.locator('.minute-dot.observed').first().waitFor();assert.equal(await page.getByLabel('Дата минутной сетки').inputValue(),new Date(now).toLocaleDateString('sv-SE',{timeZone:'Europe/Moscow'}));
  await page.getByRole('button',{name:'Закрыть детализацию'}).click();await page.unroute('**/api/v1/analytics?*');await page.route('**/api/v1/analytics?*',route=>route.fulfill({json:data}));
  data={summary:{entities:205,core:0,streams:0,messages:0,regulars:0,regularShare:0},audience:Array.from({length:205},(_,i)=>({...person,id:`legacy-${i}`,name:`Архив ${i}`,source:'youtube',tags:['архив'],attendanceSessionIds:[],attendanceRatio:0,observedMinutesPerSession:0})),categories:[],hours:[],timeline:[]};
  await renderNextHistory();
  await page.getByText('Показаны первые 200; используйте поиск или меньший период.',{exact:true}).waitFor();
  const audience=page.getByRole('heading',{name:'Возвращаемость участников',exact:true}).locator('..').locator('..');
  assert.equal(await audience.locator('tbody tr').count(),200);
  await page.getByLabel('Поиск участника').fill('Архив 204');
  assert.equal(await audience.locator('tbody tr').count(),1);
  assert.equal(await audience.getByText('архив',{exact:true}).count(),1);
  data={summary:{entities:0,core:0,streams:0,messages:0,regulars:0,regularShare:null},audience:[],categories:[],hours:[],timeline:[]};
  await renderNextHistory();
  await page.getByText('Нет активности по выбранным фильтрам. Сначала нужны собранные эфиры.',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
 } finally {await saveCoverage(page);await context.close();await browser.close();await hosted.app.close();await rm(dir,{recursive:true,force:true});}
});
