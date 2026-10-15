import test from 'node:test';
import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {assertUiLayout} from '../helpers/ui-layout.mjs';

test('people browse beyond 500 records, preserve a selected card and search across all pages',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  for(let i=0;i<501;i++)await app.db.call('createPerson',`Viewer ${String(i).padStart(3,'0')}`);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await goto(page,app.bootstrap());await page.getByRole('button',{name:'Люди',exact:true}).click();
  await page.getByLabel('Страницы людей').getByText('1–50 из 501',{exact:true}).waitFor();
  assert.equal(await page.locator('.person-row').count(),50);
  await page.getByLabel('Viewer 000',{exact:true}).click();await page.getByRole('heading',{name:'Viewer 000',exact:true}).waitFor();
  await page.getByRole('button',{name:'Следующие люди'}).click();
  await page.getByLabel('Страницы людей').getByText('51–100 из 501',{exact:true}).waitFor();
  await page.getByLabel('Viewer 050',{exact:true}).waitFor();
  await page.getByRole('heading',{name:'Viewer 000',exact:true}).waitFor();
  await page.getByLabel('Поиск человека').fill('Viewer 500');
  await page.getByLabel('Viewer 500',{exact:true}).waitFor();
  assert.equal(await page.locator('.person-row').count(),1);
  await page.getByLabel('Поиск человека').fill('');
  await page.getByLabel('Страницы людей').getByText('1–50 из 501',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Следующие люди'}).click();
  await page.getByLabel('Страницы людей').getByText('51–100 из 501',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Предыдущие люди'}).click();
  await page.getByLabel('Страницы людей').getByText('1–50 из 501',{exact:true}).waitFor();
  await assertUiLayout(page,{label:'people pagination desktop'});
  await page.setViewportSize({width:390,height:844});
  await assertUiLayout(page,{label:'people pagination mobile'});
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
