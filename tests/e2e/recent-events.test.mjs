import test from 'node:test';import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';import {assertUiLayout} from '../helpers/ui-layout.mjs';
test('stream archive and person messages show only the selected scope, paginate, escape content and fit a phone', {timeout:60000},async()=>{
 const a=await application();let browser;
 try{
  const at=Date.now()-600000,id=await a.db.call('startSession','owner','archive',at,'platform',at);
  const event=(n,text='Message '+n)=>({source:'twitch',accountId:'owner',externalId:String(n),type:'chat.message',actor:{externalId:'viewer',displayName:'Archive viewer'},occurredAtMs:at+n*1000,receivedAtMs:at+n*1000,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text}});
  for(let n=0;n<55;n++)await a.db.call('ingest',event(n,n===54?'<script>window.archiveXss=true</script>':'Message '+n));
  await a.db.call('ingest',{...event(56),type:'chat.message_delete',actor:null,payload:{targetMessageId:'0'}});
  await a.db.call('ingest',{...event(57),source:'donationalerts',type:'donation',actor:null,payload:{amountMinor:'10000',currency:'RUB',text:'Support'}});
  await a.db.call('endSession',id,at+120000);
  const second=await a.db.call('startSession','owner','other',at+180000,'platform',at+180000);await a.db.call('ingest',{...event(180,'Other stream'),actor:{externalId:'other',displayName:'Other viewer'}});await a.db.call('endSession',second,at+240000);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
  await goto(page,a.bootstrap());await page.getByRole('button',{name:'Стримы',exact:true}).click();await page.locator(`[data-session-id="${id}"]`).locator('.stream-open').click();
  assert.equal(await page.locator('.recent-events').count(),0,'archive loads only on request');
  await page.getByRole('tab',{name:'События',exact:true}).click();const archive=page.locator('.recent-events');await archive.getByText('<script>window.archiveXss=true</script>',{exact:true}).waitFor();
  assert.equal(await archive.locator('article').count(),50);assert.equal(await archive.getByText('Other stream',{exact:true}).count(),0);assert.equal(await page.evaluate(()=>window.archiveXss),undefined);
  await archive.getByRole('button',{name:'Далее',exact:true}).click();await archive.getByText('Страница 2',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelectorAll('.recent-events article').length===7);await archive.getByText('Сообщение удалено модерацией.',{exact:true}).waitFor();
  await archive.getByRole('button',{name:'Назад',exact:true}).click();await archive.getByText('Support',{exact:true}).waitFor();await archive.getByText('100,00 RUB',{exact:true}).waitFor();
  for(const width of [390,1280]){await page.setViewportSize({width,height:844});await assertUiLayout(page);}
  const midnight=Date.UTC(2026,9,21,21),long='Очень длинное сообщение без обрезки. '.repeat(12),token='x'.repeat(180);
  const compactRows=[
   {id:'short',source:'twitch',actor_name:'Egor4ik',at_ms:midnight+60000,payload:{text:'Привет!'}},
   {id:'youtube',source:'youtube',actor_name:'Mila',at_ms:midnight,payload:{text:'Я тут'}},
   {id:'long',source:'twitch',actor_name:'ДлинноеИмя'.repeat(8),at_ms:midnight-1000,payload:{text:long}},
   {id:'token',source:'youtube',actor_name:'Mila',at_ms:midnight-2000,payload:{text:token}},
   {id:'lines',source:'twitch',actor_name:'Mila',at_ms:midnight-3000,payload:{text:'Первая строка\nВторая строка'}},
   {id:'money',source:'donationalerts',actor_name:null,at_ms:midnight-4000,payload:{amountMinor:'12345',currency:'RUB',text:'Спасибо!'}},
  ].map(row=>({type:'chat.message',...row}));
  await page.route('**/api/v1/events/recent?*',route=>route.fulfill({json:compactRows}));await archive.getByRole('button',{name:'Обновить',exact:true}).click();await archive.getByText('Привет!',{exact:true}).waitFor();
  assert.equal(await archive.locator('.event-day').count(),2,'dates group by Moscow day, including midnight');
  assert.equal(await archive.locator('article time').first().textContent(),'00:01:00');
  assert.equal(await archive.locator('article time').first().getAttribute('datetime'),new Date(midnight+60000).toISOString());
  await archive.getByText('123,45 RUB',{exact:true}).waitFor();
  for(const width of [320,390,768,1440]){
   await page.setViewportSize({width,height:844});await assertUiLayout(page);
   const geometry=await archive.locator('article').first().evaluate(el=>{const bounds=Array.from(el.children).map(child=>child.getBoundingClientRect());return {height:el.getBoundingClientRect().height,centers:bounds.map(b=>(b.top+b.bottom)/2)};});
   assert.ok(geometry.height<=32,`short event is one compact line at ${width}px`);
   assert.ok(Math.max(...geometry.centers)-Math.min(...geometry.centers)<6,`time, author and message share a line at ${width}px`);
   assert.equal(await archive.locator('article').nth(2).locator('.event-text').textContent(),long);
   const longAuthor=archive.locator('article').nth(2).locator('.event-author');assert.ok((await longAuthor.boundingBox()).height<22,'long nick stays on one line');assert.ok((await longAuthor.getAttribute('title')).includes(compactRows[2].actor_name));
   assert.equal(await archive.locator('article').nth(3).locator('.event-text').textContent(),token);
   assert.ok((await archive.locator('article').nth(2).boundingBox()).height>geometry.height,'long message wraps');
   assert.ok((await archive.locator('article').nth(4).boundingBox()).height>geometry.height,'intentional newlines remain');
  }
  const colors=await archive.locator('.event-author').evaluateAll(els=>els.slice(0,2).map(el=>getComputedStyle(el).color));assert.notEqual(colors[0],colors[1]);
  await page.unroute('**/api/v1/events/recent?*');await archive.getByRole('button',{name:'Обновить',exact:true}).click();await archive.getByText('Support',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Люди',exact:true}).click();await page.getByRole('button',{name:'Archive viewer',exact:true}).click();await page.getByRole('tab',{name:'Сообщения',exact:true}).click();
  await page.locator('.recent-events').getByText('<script>window.archiveXss=true</script>',{exact:true}).waitFor();assert.equal(await page.locator('.recent-events article').count(),50);assert.equal(await page.locator('.recent-events').getByText('Other stream',{exact:true}).count(),0);
  await page.setViewportSize({width:360,height:844});await assertUiLayout(page);assert.equal(await page.title(),'Stream Panel');assert.deepEqual(errors,[]);await saveCoverage(page);
  await page.route('**/api/v1/events/recent?*',route=>route.fulfill({json:[]}));await page.locator('.recent-events').getByRole('button',{name:'Обновить',exact:true}).click();await page.getByText('Нет сохранённых сообщений за последние 48 часов.',{exact:true}).waitFor();await page.unroute('**/api/v1/events/recent?*');
  await page.route('**/api/v1/events/recent?*',route=>route.fulfill({status:400,json:{error:'Archive unavailable'}}));await page.locator('.recent-events').getByRole('button',{name:'Обновить',exact:true}).click();await page.locator('.recent-events [role=alert]').waitFor();await page.unroute('**/api/v1/events/recent?*');
  await page.locator('.recent-events').getByRole('button',{name:'Обновить',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.recent-events article').length===50);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
