import test from 'node:test';import assert from 'node:assert/strict';
import {application,seed} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
test('phone stream reads stay bounded and manual/timed refresh update counters, chart and selected minute detail',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  const id=await seed(app),at=Math.floor((Date.now()-120000)/60000)*60000;
  await app.db.call('streamSample',id,at,'g','Game','Live',3);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(6000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));let analyticsReads=0;page.on('request',r=>{if(new URL(r.url()).pathname==='/api/v1/analytics')analyticsReads++;});
  await goto(page,app.bootstrap());assert.equal(await page.getByRole('button',{name:/Автообновление/}).getAttribute('aria-pressed'),'true');assert.equal(await page.getByLabel('Интервал автообновления').inputValue(),'60');assert.deepEqual(await page.getByLabel('Интервал автообновления').locator('option').evaluateAll(es=>es.map(e=>e.value)),['60','300','900']);await page.getByRole('button',{name:'Стримы',exact:true}).click();await page.getByRole('button',{name:'Открыть',exact:true}).click();
  const metric=name=>page.locator('.stream-metrics .metric').filter({hasText:name}).locator('strong');
  await metric('Максимум зрителей').getByText('3',{exact:true}).waitFor();await page.waitForTimeout(400);assert.equal(analyticsReads,1,'rendering results must not initiate another analytics read');
  const message=async(n)=>app.db.call('ingest',{source:'twitch',accountId:'test-channel',externalId:`new-${n}`,type:'chat.message',actor:{externalId:'42',displayName:'Тестовый зритель'},occurredAtMs:at,receivedAtMs:Date.now(),sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:`Fresh ${n}`}});
  await message(1);await app.db.call('streamSample',id,at,'g','Game','Live',20);
  await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await metric('Сообщения').getByText('9',{exact:true}).waitFor();await metric('Максимум зрителей').getByText('20',{exact:true}).waitFor();assert.equal(analyticsReads,2);
  await page.getByLabel('Показатель графика стрима').selectOption('messages');await page.locator('.series-panel .chart-bar').filter({has:page.locator(`rect title`,{hasText:/всего: 2/})}).first().click();
  await page.getByRole('region',{name:'Детали выбранного столбца'}).waitFor();assert.equal(await page.locator('.stream-feed').getByText('Fresh 1',{exact:true}).count(),0);
  await message(2);await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await metric('Сообщения').getByText('10',{exact:true}).waitFor();assert.equal(await page.locator('.stream-feed').getByText('Fresh 2',{exact:true}).count(),0);assert.equal(await page.getByRole('region',{name:'Детали выбранного столбца'}).count(),1,'refresh retains selected minute');
  await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await page.waitForTimeout(200);await page.clock.install();await page.getByLabel('Интервал автообновления').selectOption('60');
  await message(3);await app.db.call('streamSample',id,at,'g','Game','Live',30);await page.clock.fastForward(61000);
  await metric('Сообщения').getByText('11',{exact:true}).waitFor();await metric('Максимум зрителей').getByText('30',{exact:true}).waitFor();assert.equal(await page.locator('.stream-feed').getByText('Fresh 3',{exact:true}).count(),0);
  const before=analyticsReads;await page.clock.fastForward(5000);assert.equal(analyticsReads,before,'no refresh before interval');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});await page.clock.fastForward(60000);assert.equal(analyticsReads,before,'hidden phone page stops requests');
  assert.equal(await page.getByRole('button',{name:/Автообновление/}).getAttribute('aria-pressed'),'true');await message(4);await app.db.call('streamSample',id,at,'g','Game','Live',40);await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'));});await metric('Сообщения').getByText('12',{exact:true}).waitFor();await metric('Максимум зрителей').getByText('40',{exact:true}).waitFor();assert.equal(analyticsReads,before+1);assert.equal(await page.locator('.stream-feed').count(),0);assert.deepEqual(errors,[]);
  assert.equal(await page.title(),'Stream Panel');assert.ok((await page.locator('main').textContent()).includes('Зрители и чат'));
  if(process.env.STREAM_PANEL_QA_SCREENSHOT)await page.screenshot({path:process.env.STREAM_PANEL_QA_SCREENSHOT,fullPage:true});await saveCoverage(page,'live-refresh');
 }finally{await browser?.close();await app.close();}
});

test('manual refresh arriving during an old automatic response waits for a new read',{timeout:30000},async()=>{
 const app=await application();let browser,release;
 try{
  const id=await seed(app);browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(6000);await goto(page,app.bootstrap());await page.getByRole('button',{name:'Стримы',exact:true}).click();await page.getByRole('button',{name:'Открыть',exact:true}).click();
  const messages=page.locator('.stream-metrics .metric').filter({hasText:'Сообщения'}).locator('strong');await messages.getByText('8',{exact:true}).waitFor();
  let delayed=false;const started=new Promise(resolve=>{release={start:resolve};}),held=new Promise(resolve=>{release.finish=resolve;});let reads=0;
  await page.route('**/api/v1/summary?*',async route=>{reads++;if(delayed){await route.continue();return;}delayed=true;const old=await route.fetch();release.start();await held;await route.fulfill({response:old});});
  await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await started;
  await app.db.call('ingest',{source:'twitch',accountId:'test-channel',externalId:'after-old-read',type:'chat.message',actor:{externalId:'42',displayName:'Viewer'},occurredAtMs:Date.now()-1000,receivedAtMs:Date.now(),sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'Newest'}});
  // Enable action is still busy; its reply completes, then the next automatic
  // refresh is held, so the manual button remains available during that read.
  release.finish();await page.getByRole('button',{name:'Обновить данные',exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('.manual-refresh').disabled);
  delayed=false;const nextStarted=new Promise(resolve=>{release.start=resolve;});const nextHeld=new Promise(resolve=>{release.finish=resolve;});
  await page.unroute('**/api/v1/summary?*');
  await page.route('**/api/v1/summary?*',async route=>{reads++;if(delayed){await route.continue();return;}delayed=true;const old=await route.fetch();release.start();await nextHeld;await route.fulfill({response:old});});
  await page.clock.install();await page.getByLabel('Интервал автообновления').selectOption('60');await page.clock.fastForward(61000);await nextStarted;
  await app.db.call('ingest',{source:'twitch',accountId:'test-channel',externalId:'manual-after-read',type:'chat.message',actor:{externalId:'42',displayName:'Viewer'},occurredAtMs:Date.now()-1000,receivedAtMs:Date.now(),sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'After snapshot'}});
  await page.getByRole('button',{name:'Обновить данные',exact:true}).click();release.finish();await messages.getByText('10',{exact:true}).waitFor();assert.equal(reads,3);
  await saveCoverage(page,'refresh-race');
 }finally{release?.finish?.();await browser?.close();await app.close();}
});
