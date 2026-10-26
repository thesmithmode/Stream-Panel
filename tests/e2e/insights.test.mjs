import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {application,seed} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {navigate} from '../helpers/navigation.mjs';
import {assertUiLayout} from '../helpers/ui-layout.mjs';

test('insights stay flat, exclude static attendance and omit accounting boilerplate; analytics has contextual phone navigation',{timeout:60000},async()=>{
 const a=await application();let browser;
 try{
  await seed(a);browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  const finding=(kind,title)=>({id:kind,kind,group:'people',title,detail:'Проверяемый вывод',basis:'Основание',action:'Проверить изменения',sampleSize:3,evidence:[]});
  await page.route('**/api/v1/analytics?*',async route=>{const response=await route.fetch({headers:{...route.request().headers(),'if-none-match':''}}),data=await response.json();if(!data.preparing)data.insights=[finding('chat_regular','Давно много писал'),finding('silent_regular','Давно смотрел'),finding('missing_regular','Перестал появляться'),{...finding('support_concentration','Основная поддержка'),basis:'Валюты считаются отдельно. Анонимные суммы включены в итог, но не приписаны одному человеку.'}];await route.fulfill({response,headers:{...response.headers(),etag:''},json:data});});
  await goto(page,a.bootstrap());await navigate(page,'Аналитика');await page.locator('.growth-plot').waitFor();
  assert.equal(await page.getByRole('navigation',{name:'Разделы',exact:true}).isVisible(),false);
  const bottom=page.locator('.analytics-mobile-navigation');assert.equal(await bottom.getByRole('tab').count(),3);await assertUiLayout(page);
  await bottom.getByRole('tab',{name:'Время',exact:true}).click();await page.getByRole('tabpanel',{name:'Время',exact:true}).waitFor();
  await bottom.getByRole('tab',{name:'Аудитория',exact:true}).click();await page.getByRole('tabpanel',{name:'Аудитория',exact:true}).waitFor();
  await bottom.getByRole('tab',{name:'Динамика',exact:true}).click();
  const section=page.getByRole('region',{name:'Инсайты',exact:true});await section.getByRole('button',{name:'Инсайты',exact:true}).click();await section.getByText('Перестал появляться',{exact:true}).waitFor();
  assert.equal(await section.getByText('Давно много писал',{exact:true}).count(),0);assert.equal(await section.getByText('Давно смотрел',{exact:true}).count(),0);assert.equal(await section.locator('details').count(),0);assert.equal(await section.getByText(/Валюты считаются отдельно/).count(),0);
  const shots=process.env.STREAM_PANEL_BROWSER_COVERAGE_DIR;if(shots){await mkdir(shots,{recursive:true});await page.screenshot({path:shots+'/analytics-navigation-mobile.png'});}
  await page.setViewportSize({width:1280,height:900});assert.equal(await bottom.isVisible(),false);assert.equal(await page.getByRole('tab',{name:'Динамика',exact:true}).count(),1);await assertUiLayout(page);
  await page.setViewportSize({width:390,height:844});await bottom.getByRole('button',{name:'Назад',exact:true}).click();await page.getByRole('region',{name:'Статистика канала за всю историю',exact:true}).waitFor();assert.equal(await page.getByRole('navigation',{name:'Разделы',exact:true}).isVisible(),true);assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
