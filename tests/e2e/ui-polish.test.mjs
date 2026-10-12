import test from 'node:test';import assert from 'node:assert/strict';
import {application,seed} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';import {assertUiLayout} from '../helpers/ui-layout.mjs';
test('real data screens fit small phones and desktop without duplicated overview content',{timeout:90000},async()=>{
 const app=await application();let browser;try{
  const sid=await seed(app);browser=await launchBrowser();const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await goto(page,app.bootstrap());
  for(const width of [320,390,768,1280]){await page.setViewportSize({width,height:844});for(const name of ['Обзор','Стримы','Люди','Аналитика','Интеграции']){
   await page.getByRole('button',{name,exact:true}).click();await page.getByRole('status').filter({hasText:'Загружаем данные…'}).waitFor({state:'detached'});
   if(name==='Обзор'){await page.locator('.channel-metrics').waitFor();assert.equal(await page.locator('.trend-chart,.event-list,.audience-ranking,input[type="datetime-local"]').count(),0);}
   if(name==='Стримы'){const row=page.locator(`tr[data-session-id="${sid}"]`);await row.waitFor();if(width<=720){const box=await row.boundingBox();assert.ok(box.y<240&&box.x+box.width<=width);}}
   if(name==='Аналитика')await page.locator('.comparison-charts').waitFor();
   assert.equal(await page.getByRole('button',{name:'Демо',exact:true}).count(),0);assert.deepEqual(errors,[]);await assertUiLayout(page);
  }}await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
