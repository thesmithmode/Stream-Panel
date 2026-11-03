import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {application,seed} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {assertUiLayout} from '../helpers/ui-layout.mjs';
import {refreshData} from '../helpers/navigation.mjs';

test('desktop charts use readable heights, empty stream sections stay hidden and refresh controls follow the viewport',{timeout:60000},async()=>{
 const a=await application();let browser;
 try{
  const sid=await seed(a),now=Date.now();await a.db.call('streamSample',sid,now-300000,'game','Game','Desktop workspace',12);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/v1/insights?*',r=>r.fulfill({json:{insights:[]}}));
  await goto(page,a.bootstrap());
  const toggle=page.getByRole('button',{name:'Автообновление Вкл',exact:true});
  await toggle.waitFor();assert.equal(await toggle.getAttribute('aria-pressed'),'true');
  assert.equal(await page.getByLabel('Интервал автообновления').inputValue(),'60');
  assert.equal(await page.locator('.sidebar-refresh .toggle-track.enabled').count(),1);
  await page.getByRole('button',{name:'Аналитика',exact:true}).click();await page.locator('.growth-plot svg').waitFor();await page.locator('.subscriber-plot svg').waitFor();
  for(const width of [1920,1440,1280,1024,768,390,320]){
   await page.setViewportSize({width,height:1000});await assertUiLayout(page);
   const daily=await page.locator('.audience-growth').boundingBox(),subscribers=await page.locator('.subscriber-growth').boundingBox();
   if(width>1100){assert.ok(Math.abs(daily.y-subscribers.y)<2);assert.ok(daily.x+daily.width<=subscribers.x);}
   else assert.ok(daily.y+daily.height<=subscribers.y+2);
   if(width>720){
    for(const selector of ['.growth-plot svg','.subscriber-plot svg']){
     const scale=await page.locator(selector).evaluate(svg=>svg.getScreenCTM().d);
     assert.ok(scale>.85&&scale<1.1,`${selector} vertical scale ${scale}`);
    }
   }
   if(process.env.STREAM_PANEL_QA_DIR){await mkdir(process.env.STREAM_PANEL_QA_DIR,{recursive:true});await page.screenshot({path:`${process.env.STREAM_PANEL_QA_DIR}/dynamics-${width}.png`});}
  }
  await page.getByRole('button',{name:'Ещё',exact:true}).click();const more=page.getByRole('dialog',{name:'Ещё',exact:true});
  await more.getByRole('button',{name:'Автообновление Вкл',exact:true}).click();assert.equal(await page.getByLabel('Интервал автообновления').count(),0);
  await more.getByRole('button',{name:'Автообновление Выкл',exact:true}).click();await more.getByLabel('Интервал автообновления').selectOption('300');await page.keyboard.press('Escape');
  await page.setViewportSize({width:1440,height:1000});assert.equal(await page.locator('.sidebar-refresh').getByLabel('Интервал автообновления').inputValue(),'300');
  await page.getByRole('button',{name:'Стримы',exact:true}).click();const followersLoaded=page.waitForResponse(r=>r.url().includes(`/sessions/${sid}/followers`));await page.locator(`[data-session-id="${sid}"] .stream-open`).click();await page.locator('.series-panel svg').waitFor();await followersLoaded;
  assert.equal(await page.getByRole('region',{name:'Инсайты',exact:true}).count(),0);
  assert.equal(await page.getByRole('region',{name:'Подписчики за стрим',exact:true}).count(),0);
  assert.equal(await page.getByRole('region',{name:'Донаты стрима',exact:true}).count(),0);
  assert.equal(await page.locator('.stream-kpis>div').filter({hasText:'Донаты'}).count(),0);
  const content={id:'finding',kind:'viewer_peak',group:'stream',title:'Устойчивый рост аудитории',detail:'Аудитория выросла с 8 до 12 зрителей на 15 минут.',basis:'Полные замеры',action:'',score:85,sampleSize:1,evidence:[]};
  await page.unroute('**/api/v1/insights?*');await page.route('**/api/v1/insights?*',r=>r.fulfill({json:{insights:[content]}}));
  await refreshData(page);await page.getByText(content.title,{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Инсайты',exact:true}).getAttribute('aria-expanded'),'true');
  await assertUiLayout(page);
  const chart=await page.locator('.series-panel').boundingBox(),insights=await page.locator('.insights-section').boundingBox();assert.ok(chart.y+chart.height<=insights.y+2,'stream insights remain below the chart');
  if(process.env.STREAM_PANEL_QA_DIR)await page.screenshot({path:`${process.env.STREAM_PANEL_QA_DIR}/stream-desktop.png`});
  assert.equal(await page.title(),'Stream Panel');assert.ok(page.url().startsWith(a.origin));assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
