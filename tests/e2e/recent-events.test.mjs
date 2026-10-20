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
  await goto(page,a.bootstrap());await page.getByRole('button',{name:'Стримы',exact:true}).click();await page.locator(`tr[data-session-id="${id}"]`).getByRole('button',{name:'Открыть',exact:true}).click();
  assert.equal(await page.locator('.recent-events').count(),0,'archive loads only on request');
  await page.getByRole('button',{name:'Показать события',exact:true}).click();const archive=page.locator('.recent-events');await archive.getByText('<script>window.archiveXss=true</script>',{exact:true}).waitFor();
  assert.equal(await archive.locator('article').count(),50);assert.equal(await archive.getByText('Other stream',{exact:true}).count(),0);assert.equal(await page.evaluate(()=>window.archiveXss),undefined);
  await archive.getByRole('button',{name:'Далее',exact:true}).click();await archive.getByText('Страница 2',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelectorAll('.recent-events article').length===7);await archive.getByText('Сообщение удалено модерацией.',{exact:true}).waitFor();
  await archive.getByRole('button',{name:'Назад',exact:true}).click();await archive.getByText('Support',{exact:true}).waitFor();await archive.getByText('100,00 RUB',{exact:true}).waitFor();
  for(const width of [390,1280]){await page.setViewportSize({width,height:844});await assertUiLayout(page);}
  await page.getByRole('button',{name:'Люди',exact:true}).click();await page.getByRole('button',{name:'Archive viewer',exact:true}).click();await page.getByRole('tab',{name:'Сообщения · 48 ч',exact:true}).click();
  await page.locator('.recent-events').getByText('<script>window.archiveXss=true</script>',{exact:true}).waitFor();assert.equal(await page.locator('.recent-events article').count(),50);assert.equal(await page.locator('.recent-events').getByText('Other stream',{exact:true}).count(),0);
  await page.setViewportSize({width:360,height:844});await assertUiLayout(page);assert.equal(await page.title(),'Stream Panel');assert.deepEqual(errors,[]);await saveCoverage(page);
  await page.route('**/api/v1/events/recent?*',route=>route.fulfill({json:[]}));await page.locator('.recent-events').getByRole('button',{name:'Обновить',exact:true}).click();await page.getByText('Нет сохранённых сообщений за последние 48 часов.',{exact:true}).waitFor();await page.unroute('**/api/v1/events/recent?*');
  await page.route('**/api/v1/events/recent?*',route=>route.fulfill({status:400,json:{error:'Archive unavailable'}}));await page.locator('.recent-events').getByRole('button',{name:'Обновить',exact:true}).click();await page.locator('.recent-events [role=alert]').waitFor();await page.unroute('**/api/v1/events/recent?*');
  await page.locator('.recent-events').getByRole('button',{name:'Обновить',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.recent-events article').length===50);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
