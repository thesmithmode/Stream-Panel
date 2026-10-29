import test from 'node:test';
import assert from 'node:assert/strict';
import {application,seed} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {navigate} from '../helpers/navigation.mjs';
import {assertUiLayout} from '../helpers/ui-layout.mjs';
test('shared person search retains off-page choices and exposes people beyond 500',{timeout:120000},async()=>{
 const a=await application();let browser;
 try{
  await seed(a);for(let i=0;i<505;i++)await a.db.call('createPerson','ZZ Viewer '+String(i).padStart(3,'0'));
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await goto(page,a.bootstrap());await navigate(page,'Люди');await page.locator('.person-row').filter({hasText:'Тестовый зритель'}).click();await page.getByRole('tab',{name:'Аккаунты',exact:true}).click();
  const search=page.getByLabel('Поиск целевого человека'),picker=page.getByLabel('Целевой человек');
  await search.fill('ZZ Viewer 504');await picker.locator('option').filter({hasText:'ZZ Viewer 504'}).waitFor({state:'attached'});const id=await picker.locator('option').filter({hasText:'ZZ Viewer 504'}).getAttribute('value');await picker.selectOption(id);
  await search.fill('');await page.getByRole('button',{name:'Следующие варианты',exact:true}).waitFor();await page.getByRole('button',{name:'Следующие варианты',exact:true}).click();await page.getByRole('button',{name:'Предыдущие варианты',exact:true}).click();assert.equal(await picker.inputValue(),id);
  await assertUiLayout(page);
  const response=await page.evaluate(async()=>{const r=await fetch('/api/v1/persons/options?search=ZZ%20Viewer%20504&limit=1');return {status:r.status,body:await r.json()};});assert.equal(response.status,200);assert.equal(response.body.items.length,1);
  await page.route('**/persons/options?**',route=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'PICKER_TEST_FAILURE'})}));await search.fill('failure');await page.getByRole('alert').filter({hasText:'PICKER_TEST_FAILURE'}).waitFor();await page.unroute('**/persons/options?**');await search.fill('ZZ Viewer 504');await picker.locator('option').filter({hasText:'ZZ Viewer 504'}).waitFor({state:'attached'});
  await page.setViewportSize({width:1280,height:900});await assertUiLayout(page);assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
