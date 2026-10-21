import test from 'node:test';
import assert from 'node:assert/strict';
import {application,seed} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {assertUiLayout} from '../helpers/ui-layout.mjs';
import {refreshData} from '../helpers/navigation.mjs';

test('compact participants expand inline without empty space, preserve sorting and fit narrow screens',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  const sid=await seed(app),base=Math.floor((Date.now()-600000)/60000)*60000;
  const people=Array.from({length:65},(_,i)=>({id:`compact-${i}`,name:i===0?'AmaliyaMelina':i===1?'ОченьДлинноеИмяБезПробелов'.repeat(6):`Viewer ${String(i).padStart(2,'0')}`,messages:i===1?123456789:65-i,activityMinutes:65-i,
   accounts:[{source:i===2?'youtube':'twitch',name:i===0?'AmaliyaMelina':'Alias that should not repeat'}],
   donations:i===0?{RUB:'22800',EUR:'500',USD:'100'}:{},
   intervals:i===3?[]:[{from:base,to:base+120000,kind:i===2?'chat_proxy':'observed'},{from:base+240000,to:base+360000,kind:i===2?'chat_proxy':'observed'}]}));
  people[1].intervals=[{from:base-86400000,to:base+60000,kind:'observed'}];
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(7000);const errors=[];let empty=false;page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/v1/analytics?*',async route=>{const response=await route.fetch(),data=await response.json();await route.fulfill({response,json:{...data,audience:empty?[]:people}});});
  await goto(page,app.bootstrap());await page.locator(`[data-session-id="${sid}"] .stream-open`).click();await page.getByRole('tab',{name:'Участники',exact:true}).click();
  const rank=page.getByRole('region',{name:'Рейтинг участников'}),rows=rank.locator('.participant-row'),toggle=rank.getByRole('button',{name:'Интервалы AmaliyaMelina',exact:true}),details=rank.getByRole('region',{name:'Интервалы AmaliyaMelina',exact:true});
  await toggle.waitFor();assert.equal(await rows.count(),50);assert.equal(await rank.locator('.account-details,.accounts,.ranking-sort').count(),0);
  assert.equal(await rank.getByText('Alias that should not repeat',{exact:true}).count(),0);
  assert.equal(await rank.getByRole('button',{name:'Интервалы Viewer 03',exact:true}).count(),0,'no empty disclosure when intervals are absent');
  assert.equal(await rows.nth(2).locator('.person-name').evaluate(e=>getComputedStyle(e).color),'rgb(255, 89, 89)');
  assert.equal(await rows.first().locator('.person-name').evaluate(e=>getComputedStyle(e).color),'rgb(169, 112, 255)');
  for(const width of [320,390,768,1440,1920]){
   await page.setViewportSize({width,height:900});await toggle.scrollIntoViewIfNeeded();
   await page.waitForFunction(expected=>document.querySelector('.audience-ranking thead tr')?.children.length===expected,width<=720?3:6);
   const before=await rows.first().boundingBox(),nextBefore=await rows.nth(1).boundingBox();
   await toggle.click();await details.waitFor();assert.equal(await toggle.getAttribute('aria-expanded'),'true');
   assert.equal(await details.getAttribute('id'),await toggle.getAttribute('aria-controls'));
   const after=await rows.first().boundingBox(),nextAfter=await rows.nth(1).boundingBox(),detailRow=await rank.locator('.interval-detail').boundingBox();
   assert.ok(Math.abs(before.height-after.height)<1,'opening intervals does not resize the summary row');
   assert.ok(Math.abs(nextAfter.y-nextBefore.y-detailRow.height)<2,'the next participant moves by exactly the expanded content height');
   assert.equal(await rank.locator('.interval-detail td').getAttribute('colspan'),width<=720?'3':'6');
   assert.equal(await details.locator('.interval-row').count(),2);await details.getByText('Пауза Twitch · 2 мин',{exact:true}).waitFor();
   await assertUiLayout(page);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await toggle.focus();await page.keyboard.press('Space');await details.waitFor({state:'detached'});assert.equal(await toggle.getAttribute('aria-expanded'),'false');
   assert.ok(Math.abs((await rows.nth(1).boundingBox()).y-nextBefore.y)<2,'collapsing removes all reserved interval space');
   if(width<=720){assert.ok((await rows.nth(2).boundingBox()).height<=60,'ordinary participant rows remain compact');assert.match(await rows.first().locator('.phone-donations').textContent(),/228,00 RUB/);}
   const longNameToggle=rows.nth(1).locator('.interval-toggle');await longNameToggle.click();await assertUiLayout(page);await longNameToggle.click();
  }
  await page.setViewportSize({width:390,height:844});await toggle.click();await details.waitFor();
  await rank.getByRole('button',{name:/^Сообщения/}).click();assert.equal(await toggle.getAttribute('aria-expanded'),'true');await details.waitFor();
  await rank.getByRole('button',{name:'Донаты, EUR',exact:true}).click();assert.equal(await rows.first().locator('.person-name').textContent(),'AmaliyaMelina');
  await rank.getByRole('button',{name:/Показать ещё/}).click();assert.equal(await rows.count(),65);
  const refreshed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/analytics'&&r.status()===200);
  await refreshData(page);await refreshed;await details.waitFor();
  assert.equal(await rows.count(),65,'auto-refresh preserves the expanded page of participants');
  empty=true;const cleared=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/analytics'&&r.status()===200);await refreshData(page);await cleared;
  await rank.getByText('Нет сохранённых данных об участниках',{exact:true}).waitFor();assert.equal(await rank.locator('.interval-detail,.interval-toggle').count(),0);await assertUiLayout(page);
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
