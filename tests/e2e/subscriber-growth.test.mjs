import test from 'node:test';import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';import {assertUiLayout} from '../helpers/ui-layout.mjs';
import {localDateWindow} from '../../dist/packages/core/src/time-audience.js';
test('subscriber timeline keeps stream shading and individual publication shapes on the count line',{timeout:60000},async()=>{
 const a=await application();let browser;
 try{
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()-86400000)),base=localDateWindow(today,'Europe/Moscow').from,h=3600000;
  a.configuration.value.twitch={userId:'owner',access:'fixture',refresh:'fixture',expiresAt:Date.now()+h,scopes:[]};a.configuration.value.youtubeAccountId='yt';
  for(const [n,total] of [[1,140],[8,141],[10,143],[12,144]])await a.db.call('followingSnapshot','twitch','owner',[],true,base+n*h,total);
  for(const [n,total] of [[1,280],[8,281],[10,284],[12,287]])await a.db.call('youtubeSnapshot','yt','channel',{statistics:{subscriberCount:String(total)}},base+n*h);
  const stream=await a.db.call('observePlatformStream','youtube','yt','broadcast',base+9*h,base+9*h,'https://youtube.com/watch?v=broadcast','Эфир');await a.db.call('endSession',stream,base+13*h);
  await a.db.call('youtubePublications','yt',[{id:'short1',title:'Неожиданный момент',publishedAt:base+8*h,kind:'shorts'},{id:'short2',title:'Спасение команды',publishedAt:base+14*h,kind:'shorts'},{id:'long',title:'Лучшие моменты',publishedAt:base+18*h,kind:'video'},{id:'short3',title:'Последний шанс',publishedAt:base+20*h,kind:'shorts'},{id:'pending',title:'Новое видео',publishedAt:base+20*h+60000,kind:'unknown'}],base+12*h);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));await goto(page,a.bootstrap());
  await page.getByRole('button',{name:'Аналитика',exact:true}).click();const card=page.locator('.subscriber-growth');await card.locator('.subscriber-total strong').filter({hasText:'144'}).waitFor();await card.getByLabel('Дата подписчиков').fill(today);await card.getByLabel('Дата подписчиков').blur();await page.waitForFunction(()=>document.querySelector('.subscriber-growth')?.getAttribute('aria-busy')==='false');assert.equal(await card.getByRole('button',{name:'Вместе',exact:true}).count(),0);
  await page.route('**/api/v1/analytics/subscribers?*',route=>route.fulfill({status:503,json:{error:'UNAVAILABLE'}}));await card.getByRole('button',{name:'YouTube',exact:true}).click();await card.getByRole('button',{name:'Повторить',exact:true}).waitFor();await page.unroute('**/api/v1/analytics/subscribers?*');await card.getByRole('button',{name:'Повторить',exact:true}).click();await card.locator('.subscriber-total strong').filter({hasText:'287'}).waitFor();assert.equal(await card.locator('.stream-band').count(),1);await card.locator('.stream-band').first().focus();await page.keyboard.press('Enter');await card.locator('.subscriber-selection').filter({hasText:/09:00–13:00/}).waitFor();await page.keyboard.press(' ');assert.equal(await card.locator('.publication-marker').count(),5);assert.equal(await card.locator('.stream-fill').getAttribute('height'),'200');assert.equal(await card.locator('.publication-marker[data-video-id=long] path').count(),1);assert.equal(await card.locator('.publication-marker[data-video-id=short1] circle').count(),1);assert.ok(Number(await card.locator('.publication-marker[data-video-id=short1] circle').getAttribute('cy'))<=230);
  await card.locator('.publication-marker').first().focus();await page.keyboard.press('Enter');await page.keyboard.press(' ');await card.locator('.publication-selection').filter({hasText:'Неожиданный момент'}).waitFor();assert.equal(await card.locator('.subscriber-publications').getAttribute('open'),null);await card.locator('.subscriber-publications summary').click();assert.equal(await card.locator('.publication-row').count(),5);await card.getByRole('button',{name:/18:00.*Видео.*Лучшие моменты/}).click();assert.equal(await card.locator('a[href="https://www.youtube.com/watch?v=long"]').count(),1);
  await card.scrollIntoViewIfNeeded();await assertUiLayout(page);await card.screenshot({path:'/tmp/subscriber-mobile.png'});await page.setViewportSize({width:320,height:844});await card.scrollIntoViewIfNeeded();await assertUiLayout(page);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.setViewportSize({width:390,height:844});
  await card.getByRole('button',{name:'7 дней',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.subscriber-growth')?.getAttribute('aria-busy')==='false');await card.locator('.publication-marker').first().click();await card.locator('.publication-selection').waitFor();assert.equal(await card.locator('.subscriber-publications').getAttribute('open'),null);
  await card.getByRole('button',{name:'30 дней',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.subscriber-growth')?.getAttribute('aria-busy')==='false');assert.equal(await card.locator('.publication-marker').count(),5);
  await card.getByRole('button',{name:'Сутки',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.subscriber-growth')?.getAttribute('aria-busy')==='false');await card.getByLabel('Дата подписчиков').fill('');await card.getByLabel('Дата подписчиков').blur();assert.equal(await card.getByLabel('Дата подписчиков').inputValue(),today);
  await card.locator('circle[role=button]').first().focus();await page.keyboard.press('Enter');await card.locator('.subscriber-selection').waitFor();assert.ok((await card.locator('.subscriber-selection').textContent()).includes('Точное время подписки неизвестно'));
  await page.evaluate(()=>window.dispatchEvent(new Event('sp:data-refresh')));await page.waitForFunction(()=>document.querySelector('.subscriber-growth')?.getAttribute('aria-busy')==='false');await page.setViewportSize({width:1280,height:900});await card.scrollIntoViewIfNeeded();await assertUiLayout(page);await card.screenshot({path:'/tmp/subscriber-desktop.png'});
  await card.getByRole('button',{name:'Twitch',exact:true}).click();await card.locator('.subscriber-total strong').filter({hasText:'144'}).waitFor();assert.equal(await card.locator('.publication-marker').count(),0);assert.ok(await card.getByRole('button',{name:'О графике подписчиков'}).count());
  await card.getByRole('button',{name:'Предыдущий период подписчиков'}).click();await card.getByText('Нет замеров за этот период.',{exact:true}).waitFor();await card.getByRole('button',{name:'Следующий период подписчиков'}).click();await card.locator('.subscriber-total strong').filter({hasText:'144'}).waitFor();
  await card.getByRole('button',{name:'YouTube',exact:true}).click();await card.locator('.stream-band').first().click();await card.getByRole('button',{name:'Открыть эфир',exact:true}).click();await page.waitForURL(url=>url.searchParams.get('stream')===stream);
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});

test('the first YouTube count is visible and compact controls leave room for the graph',{timeout:45000},async()=>{
 const a=await application();let browser;
 try{
  const at=Date.now()-60000;a.configuration.value.youtubeAccountId='yt';
  await a.db.call('youtubeSnapshot','yt','channel',{statistics:{subscriberCount:'320'}},at);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));await goto(page,a.bootstrap());
  await page.getByRole('button',{name:'Аналитика',exact:true}).click();const card=page.locator('.subscriber-growth');await card.getByRole('button',{name:'YouTube',exact:true}).click();await card.locator('.subscriber-total strong').filter({hasText:'320'}).waitFor();
  assert.equal(await card.locator('.count-marker').count(),1);assert.ok(await card.locator('.count-marker').evaluate(el=>el.getBoundingClientRect().width>5));
  await card.getByRole('button',{name:'О графике подписчиков'}).click();await card.getByRole('dialog').filter({hasText:'Последний замер:'}).waitFor();await page.keyboard.press('Escape');
  for(const width of [320,390,768,1280]){
   await page.setViewportSize({width,height:900});await card.scrollIntoViewIfNeeded();await assertUiLayout(page);
   const bounds=await card.evaluate(el=>{const box=el.getBoundingClientRect(),plot=el.querySelector('.subscriber-plot').getBoundingClientRect();return {controls:plot.top-box.top,plotHeight:plot.height};});
   assert.ok(bounds.controls<240,`compact controls at ${width}: ${JSON.stringify(bounds)}`);assert.ok(bounds.plotHeight>200,`visible graph at ${width}`);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  }
  await a.db.call('youtubeSnapshot','yt','channel',{statistics:{subscriberCount:'321'}},at+30000);await page.evaluate(()=>window.dispatchEvent(new Event('sp:data-refresh')));await card.locator('.subscriber-total strong').filter({hasText:'321'}).waitFor();assert.ok((await card.locator('.subscriber-plot path').getAttribute('d')).includes('H'));
  await page.setViewportSize({width:390,height:844});await card.scrollIntoViewIfNeeded();await card.screenshot({path:'/tmp/subscriber-youtube-fixed-mobile.png'});
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});

 test('YouTube draws a line immediately after midnight from the last known count',{timeout:45000},async()=>{
  const a=await application();let browser;
  try{
   const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),midnight=localDateWindow(today,'Europe/Moscow').from;
   a.configuration.value.youtubeAccountId='yt';
   await a.db.call('youtubeSnapshot','yt','channel',{statistics:{subscriberCount:'29'}},midnight-60000);
   browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(8000);await goto(page,a.bootstrap());
   await page.getByRole('button',{name:'Аналитика',exact:true}).click();const card=page.locator('.subscriber-growth');await card.getByRole('button',{name:'YouTube',exact:true}).click();await card.locator('.subscriber-total strong').filter({hasText:'29'}).waitFor();
   const line=card.locator('.subscriber-line');assert.ok((await line.getAttribute('d')).includes('H'));assert.ok(await line.evaluate(el=>el.getBoundingClientRect().width>0));
   await card.scrollIntoViewIfNeeded();await card.screenshot({path:'/tmp/subscriber-midnight-mobile.png'});await saveCoverage(page);
  }finally{await browser?.close();await a.close();}
 });
