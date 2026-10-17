import {mkdir} from 'node:fs/promises';import {join} from 'node:path';import test from 'node:test';import assert from 'node:assert/strict';
import {application,seed} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';import {assertUiLayout} from '../helpers/ui-layout.mjs';
test('real data screens fit small phones and desktop without duplicated overview content',{timeout:90000},async()=>{
 const app=await application();let browser;try{
  const sid=await seed(app);browser=await launchBrowser();const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await goto(page,app.bootstrap());
  for(const width of [320,390,768,1280]){await page.setViewportSize({width,height:844});for(const name of ['Обзор','Стримы','Люди','Аналитика','Донаты','Интеграции','Настройки']){
   await page.getByRole('button',{name,exact:true}).click();await page.getByRole('status').filter({hasText:'Загружаем данные…'}).waitFor({state:'detached'});
   if(name==='Обзор'){await page.locator('.channel-metrics').waitFor();assert.equal(await page.locator('.trend-chart,.event-list,.audience-ranking,input[type="datetime-local"]').count(),0);}
   if(name==='Стримы'){const row=page.locator(`tr[data-session-id="${sid}"]`);await row.waitFor();if(width<=720){const box=await row.boundingBox();const panel=await page.locator(".sessions-page .panel").boundingBox(),heading=await page.locator(".page-heading").boundingBox();assert.ok(box.y<480&&box.x+box.width<=width,JSON.stringify(box));assert.ok(panel.y-(heading.y+heading.height)<=24,"No blank vertical space before stream history");}}
   if(name==='Люди'){for(const tab of ['Чаттеры','Донатеры','Зрители']){await page.getByRole('tab',{name:tab,exact:true}).click();await page.locator('.person-row .count').first().waitFor();if(tab==='Донатеры')await page.locator('.person-row .count').filter({hasText:'250,00 RUB'}).waitFor();}await page.getByRole('tab',{name:'Все',exact:true}).click();await page.locator('.person-row').first().waitFor();}
   if(name==='Аналитика'){
    await page.locator('.comparison-charts').waitFor();
    if(width===320){
     const start=await page.getByLabel('Начало периода',{exact:true}).boundingBox(),end=await page.getByLabel('Конец периода',{exact:true}).boundingBox(),panel=await page.locator('.analytics-filter').boundingBox();
     assert.ok(start.width>panel.width*.75&&end.y>=start.y+start.height,'date and time fields remain readable on narrow phones');
     const heading=await page.locator('.activity-clock h2').boundingBox(),help=await page.getByRole('button',{name:'О суточном графике',exact:true}).boundingBox();assert.ok(help.y<heading.y+heading.height,'help stays beside the wrapping heading');
     const labels=await page.locator('.time-audience .hour-axis span').evaluateAll(nodes=>nodes.filter(n=>getComputedStyle(n).visibility!=='hidden').map(n=>{const r=document.createRange();r.selectNodeContents(n);const box=r.getBoundingClientRect();return {text:n.textContent,left:box.left,right:box.right};}));
     assert.deepEqual(labels.map(n=>n.text),['0','3','6','9','12','15','18','21']);assert.ok(labels.every((n,i)=>!i||n.left>=labels[i-1].right),'clock labels do not overlap');
    }
   }
   assert.equal(await page.getByRole('button',{name:'Демо',exact:true}).count(),0);assert.deepEqual(errors,[]);await assertUiLayout(page);if(width===390&&['Обзор','Стримы','Аналитика'].includes(name)&&process.env.STREAM_PANEL_BROWSER_COVERAGE_DIR){const dir=process.env.STREAM_PANEL_BROWSER_COVERAGE_DIR;await mkdir(dir,{recursive:true});await page.screenshot({path:join(dir,`mobile-${['Обзор','Стримы','Аналитика'].indexOf(name)}.png`),fullPage:name!=='Аналитика'});}
  }}await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
