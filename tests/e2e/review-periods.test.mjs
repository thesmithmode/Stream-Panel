import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {assertUiLayout} from '../helpers/ui-layout.mjs';

test('empty daily chart captions stay below their controls at desktop and phone widths',{timeout:30000},async()=>{
 const a=await application();let browser;
 try{
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1280,height:900}});
  await goto(page,a.bootstrap());await page.getByRole('button',{name:'Аналитика',exact:true}).click();
  const caption=page.locator('.audience-growth .growth-caption');await caption.waitFor();
  for(const width of [1280,1440,390,320]){
   await page.setViewportSize({width,height:900});await assertUiLayout(page);
   const toolbar=await page.locator('.daily-chart-toolbar').boundingBox(),note=await caption.boundingBox();
   assert.ok(note.y>=toolbar.y+toolbar.height,JSON.stringify({width,toolbar,note}));
  }
  await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});

test('one toolbar controls subscriber windows, custom dates validate locally, and desktop chart edges align',{timeout:60000},async()=>{
 const a=await application();let browser;
 try{
  const now=Date.now(),day=86400000;
  a.configuration.value.twitch={userId:'owner',access:'fixture',refresh:'fixture',expiresAt:now+3600000,scopes:[]};
  a.configuration.value.youtubeAccountId='yt';
  for(const [ago,total] of [[70,50],[20,55],[1,56]]){
   const at=now-ago*day,id=await a.db.call('observePlatformStream','twitch','owner',`review-${ago}`,at,at,null,'Обзор интерфейса');
   await a.db.call('streamSample',id,at,'game','Game','',11);await a.db.call('endSession',id,at+60000);
   await a.db.call('followingSnapshot','twitch','owner',[],true,at,total);
   await a.db.call('youtubeSnapshot','yt','channel',{statistics:{subscriberCount:String(total-20)}},at);
  }
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],requests=[];
  page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{const url=new URL(request.url());if(url.pathname==='/api/v1/analytics/subscribers')requests.push(url);});
  await goto(page,a.bootstrap());await page.getByRole('button',{name:'Аналитика',exact:true}).click();
  const toolbar=page.locator('.analytics-toolbar'),card=page.locator('.subscriber-growth');
  await card.locator('[data-source=twitch] strong').filter({hasText:'56'}).waitFor();
  assert.equal(await card.locator('.subscriber-controls,input[type=date],.period-switch').count(),0);
  assert.ok(Number(requests.at(-1).searchParams.get('to'))-Number(requests.at(-1).searchParams.get('from'))>60*day);
  await page.getByRole('button',{name:'По месяцам',exact:true}).click();
  let releasePage,finishPage;const heldPage=new Promise(resolve=>releasePage=resolve),finishedPage=new Promise(resolve=>finishPage=resolve);
  await page.route('**/api/v1/analytics?*',async route=>{if(new URL(route.request().url()).searchParams.has('streamFrom')){await heldPage;try{await route.continue();}finally{finishPage();}}else await route.continue();});
  try{
   await page.getByRole('button',{name:'Предыдущие дни',exact:true}).click();await page.getByRole('status').filter({hasText:'Загрузка дней…'}).waitFor();
   await page.getByRole('button',{name:'Следующие дни',exact:true}).click();await page.getByRole('status').filter({hasText:'Загрузка дней…'}).waitFor({state:'detached'});
  }finally{releasePage();await finishedPage;await page.unroute('**/api/v1/analytics?*');}
  for(const [name,days] of [['7 дней',7],['30 дней',30]]){
   const count=requests.length,response=page.waitForResponse(response=>{
    const url=new URL(response.url()),span=Number(url.searchParams.get('to'))-Number(url.searchParams.get('from'));
    return url.pathname==='/api/v1/analytics/subscribers'&&Math.abs(span-days*day)<60000;
   });
   await toolbar.getByRole('button',{name,exact:true}).click();await response;
   await page.waitForFunction(()=>document.querySelector('.analytics-results')?.getAttribute('aria-busy')==='false');
   await page.waitForFunction(()=>document.querySelector('.subscriber-growth')?.getAttribute('aria-busy')==='false');
   assert.equal(requests.length,count+2);
   const q=requests.at(-1).searchParams,span=Number(q.get('to'))-Number(q.get('from'));
   assert.ok(Math.abs(span-days*day)<60000,`shared ${name}: ${span}`);
  }
  await toolbar.getByRole('button',{name:'Свои даты',exact:true}).click();
  await page.getByLabel('Начало периода',{exact:true}).fill('2026-09-01T12:00');
  await page.getByLabel('Конец периода',{exact:true}).fill('2026-09-01T11:00');
  await page.getByRole('alert').filter({hasText:'Укажите начало периода'}).waitFor();
  await page.getByLabel('Конец периода',{exact:true}).fill('2026-10-31T12:00');
  await page.getByRole('button',{name:'Готово',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.subscriber-range')?.textContent==='01.09–31.10');
  assert.equal(await page.getByRole('alert').count(),0);
  const custom=requests.at(-1).searchParams;
  assert.equal(Number(custom.get('from')),Date.parse('2026-09-01T12:00'));
  assert.equal(Number(custom.get('to')),Date.parse('2026-10-31T12:00'));
  await toolbar.getByRole('button',{name:'Всё время',exact:true}).click();
  await card.locator('[data-source=twitch] strong').filter({hasText:'56'}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.subscriber-growth')?.getAttribute('aria-busy')==='false');
  for(const width of [1440,1280,1024,390,320]){
   await page.setViewportSize({width,height:1000});await page.evaluate(()=>window.scrollTo(0,0));await assertUiLayout(page);
   const geometry=await page.locator('.dynamics-grid').evaluate(el=>{
    const box=selector=>el.querySelector(selector).getBoundingClientRect().toJSON();
    return {daily:box('.audience-growth'),subscriber:box('.subscriber-growth'),left:box('.growth-plot'),right:box('.subscriber-plot')};
   });
   if(width>1100){
    assert.ok(Math.abs(geometry.daily.height-geometry.subscriber.height)<1,JSON.stringify(geometry));
    assert.ok(Math.abs(geometry.left.y-geometry.right.y)<1,JSON.stringify(geometry));
    assert.ok(Math.abs(geometry.left.height-geometry.right.height)<1,JSON.stringify(geometry));
   }else assert.ok(geometry.daily.y+geometry.daily.height<=geometry.subscriber.y);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await mkdir('/tmp/stream-panel-qa',{recursive:true});await page.screenshot({path:`/tmp/stream-panel-qa/analytics-${width}.png`,fullPage:false});
  }
  assert.equal(await page.title(),'Stream Panel');assert.ok(page.url().startsWith(a.origin));assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
