import test from 'node:test';
import assert from 'node:assert/strict';
import {application,seed} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {assertUiLayout} from '../helpers/ui-layout.mjs';

test('demo overview and all navigation screens remain usable from small phones to desktop',{timeout:90000},async()=>{
 const app=await application();let browser;
 try{
  await seed(app);browser=await launchBrowser();const page=await browser.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await goto(page,app.bootstrap());await page.getByRole('button',{name:'Демо',exact:true}).click();
  for(const width of [320,390,768,1280]){
   await page.setViewportSize({width,height:844});
   for(const name of ['Обзор','Стримы','Люди','Аналитика','Интеграции']){
    await page.getByRole('button',{name,exact:true}).click();
    await page.getByRole('status').filter({hasText:'Загружаем данные…'}).waitFor({state:'detached'});
    if(name==='Обзор'){
     await page.locator('.channel-metrics').waitFor();
     assert.equal(await page.locator('.stream-list button').count(),2);
     await page.getByLabel('Метрика графика',{exact:true}).selectOption('observed');
     await page.locator('.trend-plot svg').waitFor();
    }
    if(name==='Аналитика')await page.locator('.analytics-chart').waitFor();
    assert.deepEqual(errors,[]);await assertUiLayout(page);
   }
  }
  await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
