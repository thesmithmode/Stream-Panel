import {navigate,setFilter} from '../helpers/navigation.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';import {assertUiLayout} from '../helpers/ui-layout.mjs';
test('daily bars expose online and chat activity, preserve missing days and open the exact broadcast',{timeout:60000},async()=>{
 const a=await application();let browser;
 try{
  const minute=60000,day=86400000,base=Math.floor((Date.now()-60*day)/day)*day+7*3600000,ids=[];
  for(let n=0;n<55;n++){const at=base+n*day,id=await a.db.call('startSession','owner',`growth-${n}`,at,'platform',at);ids.push(id);await a.db.call('streamSample',id,at,'game','Game','Repeated title',n);await a.db.call('ingest',{source:'twitch',accountId:'owner',externalId:`message-${n}`,type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}});await a.db.call('endSession',id,at+minute);}
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.clock.setFixedTime(base+55*day);await goto(page,a.bootstrap());
  await navigate(page,'Аналитика');const chart=page.locator('.audience-growth');await chart.locator('svg g').nth(29).waitFor();assert.equal(await chart.locator('svg g').count(),30);assert.equal(await chart.locator('svg > path').count(),0);
  assert.ok(await chart.locator('.daily-bar').count()>0,'single-platform online remains visible in Together');
  await chart.getByRole('button',{name:'Twitch',exact:true}).click();await chart.locator('svg g[data-missing="false"]').first().click();assert.match(await chart.locator('.growth-selection').textContent(),/Средний онлайн: 26/);
  await chart.getByRole('button',{name:'YouTube',exact:true}).click();assert.equal(await chart.locator('.daily-bar').count(),0);assert.match(await chart.locator('svg g').first().getAttribute('aria-label'),/нет данных/);
  await chart.getByRole('button',{name:'Активные в чате',exact:true}).click();assert.ok(await chart.locator('.daily-bar').count()>0);assert.match(await chart.locator('.growth-selection').textContent(),/Активные в чате: 1/);assert.equal(await chart.getByRole('group',{name:'Источник динамики'}).count(),0);
  await chart.getByRole('button',{name:'Средний онлайн',exact:true}).click();await chart.getByRole('button',{name:'Вместе',exact:true}).click();
  await chart.getByRole('button',{name:'Предыдущие дни',exact:true}).click();await chart.locator('svg g').first().click();assert.match(await chart.locator('.growth-selection').textContent(),/Средний онлайн: 0/);await chart.getByRole('button',{name:'Следующие дни',exact:true}).click();
  await setFilter(page,'Период аналитики','7');await page.waitForFunction(()=>document.querySelectorAll('.audience-growth svg g').length<=8);assert.ok(await chart.locator('svg g').count()<=8);
  await setFilter(page,'Период аналитики','all');await chart.locator('svg g').nth(29).waitFor();
  await page.route('**/api/v1/analytics?*',async route=>{const response=await route.fetch(),data=await response.json();if(data.streamComparison)data.streamComparison=data.streamComparison.map((s,i)=>i===50?{...s,viewers:{all:{mean:null},known:{mean:null},twitch:{mean:null},youtube:{mean:null}}}:s);await route.fulfill({response,json:data});});
  await page.evaluate(()=>window.dispatchEvent(new Event('sp:data-refresh')));await page.waitForFunction(()=>document.querySelectorAll('.audience-growth svg g')[24]?.getAttribute('data-missing')==='true');assert.equal(await chart.locator('g[data-missing="true"] .daily-bar').count(),0);await page.unrouteAll({behavior:'wait'});
  await chart.locator('svg g[data-missing="false"]').first().focus();await page.keyboard.press('Enter');await page.keyboard.press(' ');assert.equal(await chart.locator('svg g[data-missing="false"]').first().getAttribute('aria-pressed'),'true');
  for(const width of [320,390,768,1280]){await page.setViewportSize({width,height:844});await page.evaluate(()=>window.scrollTo(0,0));await assertUiLayout(page);await chart.screenshot({path:`/tmp/analytics-growth-${width}.png`});}
  await chart.locator('.growth-stream').click();await page.waitForURL(url=>url.searchParams.get('stream')===ids[26]);await page.goBack();await chart.locator('svg g').nth(29).waitFor();await chart.locator('svg g').nth(28).click();await chart.locator('.growth-stream').click();await page.waitForURL(url=>url.searchParams.get('stream')===ids[54]);assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
