import test from 'node:test';import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';import {assertUiLayout} from '../helpers/ui-layout.mjs';
import {localDateWindow} from '../../dist/packages/core/src/time-audience.js';

// Inspect the screenshot's painted pixels, rather than only an SVG path's presence.
async function paintedLineWidth(page,card,source){
 await card.locator('.subscriber-plot').evaluate(el=>el.scrollIntoView({block:'center'}));
 const png=await card.locator('.subscriber-plot').screenshot();
 return page.evaluate(async({bytes,source})=>{
  const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));
  const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
  const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
  const {data}=ctx.getImageData(0,0,canvas.width,canvas.height);let longest=0;
  for(let y=0;y<canvas.height;y++){let run=0;for(let x=0;x<canvas.width;x++){
   const i=(y*canvas.width+x)*4,r=data[i],g=data[i+1],b=data[i+2];
   const painted=source==='Twitch'?b>170&&r>100&&b>g*1.4:r>180&&r>g*1.7&&r>b*1.7;
   run=painted?run+1:0;longest=Math.max(longest,run);
  }}
  return {longest,width:canvas.width};
 },{bytes:[...png],source});
}

test('both subscriber series paint continuous unchanged totals on one scale at mobile and desktop widths',{timeout:60000},async()=>{
 const a=await application();let browser;
 try{
  const midnight=localDateWindow('2026-10-21','Europe/Moscow').from,now=midnight+5*60000;
  a.configuration.value.twitch={userId:'owner',access:'fixture',refresh:'fixture',expiresAt:Date.now()+3600000,scopes:[]};a.configuration.value.youtubeAccountId='yt';
  await a.db.call('followingSnapshot','twitch','owner',[],true,midnight-31*86400000,56);
  await a.db.call('youtubeSnapshot','yt','channel',{statistics:{subscriberCount:'29'}},midnight-31*86400000);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));await page.clock.setFixedTime(now);
  await goto(page,a.bootstrap());await page.getByRole('button',{name:'Аналитика',exact:true}).click();const card=page.locator('.subscriber-growth');await card.locator('[data-source=twitch] strong').filter({hasText:'56'}).waitFor();await card.locator('[data-source=youtube] strong').filter({hasText:'29'}).waitFor();
  assert.equal(await card.getByRole('button',{name:'Twitch',exact:true}).count(),0);assert.equal(await card.getByRole('button',{name:'YouTube',exact:true}).count(),0);assert.equal(await card.getByRole('button',{name:'Сутки',exact:true}).count(),0);
  for(const period of ['30 дней','7 дней']){
   await card.getByRole('button',{name:period,exact:true}).click();await page.waitForFunction(()=>document.querySelector('.subscriber-growth')?.getAttribute('aria-busy')==='false');
   for(const width of [320,390,1280]){await page.setViewportSize({width,height:900});await card.scrollIntoViewIfNeeded();for(const source of ['Twitch','YouTube']){const painted=await paintedLineWidth(page,card,source);assert.ok(painted.longest>painted.width*.65,`${source} ${period} ${width}: ${JSON.stringify(painted)}`);}await assertUiLayout(page);}
  }
  assert.equal(await card.locator('.subscriber-history-note').count(),0);assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
test('combined timeline hides publications before YouTube observations, retains earlier streams and removes publication clutter',{timeout:60000},async()=>{
 const a=await application();let browser;
 try{
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()-86400000)),base=localDateWindow(today,'Europe/Moscow').from,h=3600000;
  a.configuration.value.twitch={userId:'owner',access:'fixture',refresh:'fixture',expiresAt:Date.now()+h,scopes:[]};a.configuration.value.youtubeAccountId='yt';
  for(const [n,total] of [[1,52],[8,53],[10,55],[12,56]])await a.db.call('followingSnapshot','twitch','owner',[],true,base+n*h,total);
  for(const [n,total] of [[8,29],[10,30],[12,31]])await a.db.call('youtubeSnapshot','yt','channel',{statistics:{subscriberCount:String(total)}},base+n*h);
  const early=await a.db.call('observePlatformStream','youtube','yt','early',base+2*h,base+2*h,'https://youtube.com/watch?v=early','Ранний эфир');await a.db.call('endSession',early,base+3*h);
  const tw=await a.db.call('observePlatformStream','twitch','owner','tw',base+9*h,base+9*h,'https://twitch.tv/owner','Вместе');
  const yt=await a.db.call('observePlatformStream','youtube','yt','yt-live',base+9*h,base+9*h,'https://youtube.com/watch?v=yt-live','Вместе');await a.db.call('endSession',tw,base+13*h);if(yt!==tw)await a.db.call('endSession',yt,base+13*h);
  await a.db.call('youtubePublications','yt',[{id:'old-short',title:'СКРЫТЫЙ СТАРЫЙ ШОРТС',publishedAt:base+7*h,kind:'shorts'},{id:'old-video',title:'СКРЫТОЕ СТАРОЕ ВИДЕО',publishedAt:base+7*h,kind:'video'},{id:'short',title:'СКРЫТОЕ НАЗВАНИЕ ШОРТСА',publishedAt:base+8*h,kind:'shorts'},{id:'long',title:'Большое видео',publishedAt:base+18*h,kind:'video'}],base+20*h);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));await goto(page,a.bootstrap());await page.getByRole('button',{name:'Аналитика',exact:true}).click();const card=page.locator('.subscriber-growth');await card.locator('[data-source=youtube] strong').filter({hasText:'31'}).waitFor();await card.getByLabel('Дата подписчиков').fill(today);await card.getByLabel('Дата подписчиков').blur();await page.waitForFunction(()=>document.querySelector('.subscriber-growth')?.getAttribute('aria-busy')==='false');
  assert.equal(await card.locator('.subscriber-line').count(),2);assert.equal(await card.locator('.publication-marker').count(),2);assert.equal(await card.locator('[data-video-id^=old]').count(),0);
  assert.equal(await card.locator('.stream-band[data-source=both]').count(),1);assert.equal(await card.locator('.stream-band[data-source=youtube]').count(),1);await card.getByText('YouTube: история с',{exact:false}).waitFor();
  await card.locator('[data-video-id=short]').focus();await page.keyboard.press('Enter');await card.locator('.publication-selection').filter({hasText:'Shorts'}).waitFor();assert.equal((await card.textContent()).includes('СКРЫТОЕ НАЗВАНИЕ'),false);assert.equal((await card.locator('[data-video-id=short] title').textContent()).includes('СКРЫТОЕ'),false);
  assert.equal(await card.locator('.subscriber-publications').count(),0);assert.equal(await card.getByRole('link',{name:/Открыть на YouTube/}).count(),0);
  await card.locator('[data-video-id=long]').focus();await page.keyboard.press(' ');await card.locator('.publication-selection').filter({hasText:'Большое видео'}).waitFor();
  await card.locator('[data-series=youtube] .count-marker').first().focus();await page.keyboard.press('Enter');await card.getByText('Замер счётчика. Точное время подписки неизвестно.').waitFor();
  for(const width of [320,390,768,1280]){await page.setViewportSize({width,height:900});await card.scrollIntoViewIfNeeded();await assertUiLayout(page);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await card.screenshot({path:`/tmp/combined-subscribers-${width}.png`});}
  await card.getByRole('button',{name:'30 дней',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.subscriber-growth')?.getAttribute('aria-busy')==='false');assert.equal(await card.locator('.publication-marker').count(),2);
  await card.getByLabel('Дата подписчиков').fill('');await card.getByLabel('Дата подписчиков').blur();assert.equal(await card.getByLabel('Дата подписчиков').inputValue(),today);
  await card.getByRole('button',{name:'Предыдущий период подписчиков'}).click();await card.getByText('Нет замеров за этот период.',{exact:true}).waitFor();await card.getByRole('button',{name:'Следующий период подписчиков'}).click();await card.locator('[data-source=youtube] strong').filter({hasText:'31'}).waitFor();
  await card.locator('.stream-band[data-source=both]').click();await card.getByRole('button',{name:'Открыть эфир',exact:true}).click();await page.waitForURL(url=>url.searchParams.has('stream'));assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
test('combined timeline retries failed loads and refreshes both platform counts',{timeout:45000},async()=>{
 const a=await application();let browser;
 try{
  a.configuration.value.youtubeAccountId='yt';const at=Date.now()-60000;await a.db.call('youtubeSnapshot','yt','channel',{statistics:{subscriberCount:'29'}},at);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(8000);await page.route('**/api/v1/analytics/subscribers?*',route=>route.fulfill({status:503,json:{error:'UNAVAILABLE'}}));await goto(page,a.bootstrap());await page.getByRole('button',{name:'Аналитика',exact:true}).click();const card=page.locator('.subscriber-growth');await card.getByRole('button',{name:'Повторить',exact:true}).waitFor();await page.unroute('**/api/v1/analytics/subscribers?*');await card.getByRole('button',{name:'Повторить',exact:true}).click();await card.locator('[data-source=youtube] strong').filter({hasText:'29'}).waitFor();
  await a.db.call('youtubeSnapshot','yt','channel',{statistics:{subscriberCount:'30'}},at+30000);await page.evaluate(()=>window.dispatchEvent(new Event('sp:data-refresh')));await card.locator('[data-source=youtube] strong').filter({hasText:'30'}).waitFor();await card.getByRole('button',{name:'О графике подписчиков'}).click();await card.getByRole('dialog').waitFor();await page.keyboard.press('Escape');await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
