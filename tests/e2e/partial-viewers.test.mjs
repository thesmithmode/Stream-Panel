import {clockSettings} from '../helpers/navigation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {assertUiLayout} from '../helpers/ui-layout.mjs';

test('partial provider counters remain visible and labelled in stream cards, overview and Monday analytics',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  const minute=60000,base=Date.parse('2026-10-19T06:00:00Z');
  const id=await app.db.call('observePlatformStream','twitch','owner','monday-stream',base,base,null,'Monday partial viewers');
  await app.db.call('observePlatformStream','youtube','channel','video_AAAAAA',base,base,null,'Monday partial viewers');
  for(const [i,count]of [8,4].entries()){
   await app.db.call('streamSample',id,base+i*minute+3000,'dota','Dota 2','Monday partial viewers',count);
   await app.db.call('youtubeViewers',base+i*minute+20000,null,id);
  }
  await app.db.call('endSession',id,base+2*minute);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await goto(page,app.bootstrap());assert.equal(await page.title(),'Stream Panel');
  await page.getByRole('button',{name:'Стримы',exact:true}).click();
  const row=page.locator(`[data-session-id="${id}"]`),count=row.locator('.stream-card-metrics>div').nth(1);
  assert.match(await count.textContent(),/6/);await row.locator('.stream-actions summary').click();assert.match(await row.textContent(),/Пик зрителей: 8/);assert.equal(await page.locator('body').textContent().then(t=>t.includes('≥')),false);assert.match(await row.textContent(),/Неполные данные площадок/);
  await assertUiLayout(page);
  if(process.env.STREAM_PANEL_QA_SCREENSHOTS)await page.screenshot({path:'/tmp/sp-partial-stream-390.png',fullPage:true});
  await page.keyboard.press('Escape');await row.locator('.stream-open').click();
  await page.locator('.stream-kpis').getByText('8',{exact:true}).waitFor();await page.locator('.stream-kpis').getByText('6',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Аналитика',exact:true}).click();
  await page.getByRole('tab',{name:'Время',exact:true}).click();await page.getByText('Настроить карту',{exact:true}).click();await page.getByLabel('Расчёт карты').waitFor();await page.getByLabel('Метрика карты',{exact:true}).selectOption('viewers');
  const cell=page.locator('.hour-heatmap button[aria-label^="пн 9:00"]');await cell.waitFor();
  await page.waitForFunction(()=>document.querySelector('.hour-heatmap button[aria-label^="пн 9:00"]')?.getAttribute('aria-label')?.includes('6'));assert.match(await cell.getAttribute('aria-label'),/6[.,]0/);await cell.click();
  await clockSettings(page);const clock=page.locator('.activity-clock');await clock.getByLabel('Шаг графика').selectOption('60');
  const bucket=clock.getByRole('button',{name:/09:00–10:00: 6/});await bucket.click();
  assert.match(await clock.locator('.clock-caption[role="status"]').textContent(),/6/);
  await clock.getByLabel('Метрика графика').selectOption('youtubeViewers');
  assert.equal(await clock.getByRole('button',{name:/09:00–10:00: нет данных/}).count(),1);
  await clock.getByLabel('Метрика графика').selectOption('twitchViewers');
  assert.equal(await clock.getByRole('button',{name:/09:00–10:00: 6/}).count(),1);
  await clock.getByLabel('Метрика графика').selectOption('viewers');
  for(const width of [390,1280]){await page.setViewportSize({width,height:900});await assertUiLayout(page);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);if(process.env.STREAM_PANEL_QA_SCREENSHOTS)await page.screenshot({path:`/tmp/sp-partial-analytics-${width}.png`,fullPage:true});}
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
