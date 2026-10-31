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
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],unpagedReads=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/v1/persons')unpagedReads.push(request.url());});
  await goto(page,app.bootstrap());await page.getByRole('button',{name:'Люди',exact:true}).click();
  await page.getByLabel('Страницы людей').getByText('1–50 из 501 записей',{exact:true}).waitFor();
  assert.equal(await page.locator('.person-row').count(),50);
  assert.deepEqual(unpagedReads,[],'browsing a page must not also load the unpaged directory');
  await page.getByLabel('Viewer 000',{exact:true}).click();await page.getByRole('heading',{name:'Viewer 000',exact:true}).waitFor();
  await page.getByRole('button',{name:'Следующие люди'}).click();
  await page.getByLabel('Страницы людей').getByText('51–100 из 501 записей',{exact:true}).waitFor();
  await page.getByLabel('Viewer 050',{exact:true}).waitFor();
  await page.getByRole('heading',{name:'Viewer 000',exact:true}).waitFor();
  await page.getByLabel('Поиск человека').fill('Viewer 500');
  await page.getByLabel('Viewer 500',{exact:true}).waitFor();
  assert.equal(await page.locator('.person-row').count(),1);
  await page.getByLabel('Поиск человека').fill('');
  await page.getByLabel('Страницы людей').getByText('1–50 из 501 записей',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Следующие люди'}).click();
  await page.getByLabel('Страницы людей').getByText('51–100 из 501 записей',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Предыдущие люди'}).click();
  await page.getByLabel('Страницы людей').getByText('1–50 из 501 записей',{exact:true}).waitFor();
  for(const height of [720,1000]){
   await page.setViewportSize({width:1280,height});await page.locator('.people-list').evaluate(el=>el.scrollTop=el.scrollHeight);
   const boxes=await page.evaluate(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {top:r.top,bottom:r.bottom}};return {last:rect('.person-row:last-child'),list:rect('.people-list'),pages:rect('.people-pages'),height:innerHeight}});
   assert.ok(boxes.last.bottom<=boxes.list.bottom+1);assert.ok(boxes.pages.bottom<=boxes.height+1);assert.ok(boxes.pages.top>=boxes.list.bottom-1);await assertUiLayout(page);
  }
  await page.screenshot({path:'/tmp/people-directory-1280.png'});
  await page.setViewportSize({width:390,height:844});
  await assertUiLayout(page,{label:'people pagination mobile'});
  assert.equal(await page.getByRole('region',{name:'Список людей'}).isVisible(),false);
  await page.getByRole('button',{name:'К списку людей',exact:true}).click();
  await page.getByLabel('Viewer 001',{exact:true}).click();
  await page.getByRole('heading',{name:'Viewer 001',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.scrollY),0,'phone cards open at the top');
  await page.goBack();
  await page.getByRole('region',{name:'Список людей'}).waitFor();
  assert.equal(await page.locator('.person-detail').isVisible(),false,'browser back returns to the directory');
  await page.goForward();
  await page.getByRole('heading',{name:'Viewer 001',exact:true}).waitFor();
  await page.getByRole('tab',{name:'Аккаунты',exact:true}).click();
  await page.getByLabel('Имя человека').waitFor();
  await assertUiLayout(page);
  await page.getByRole('button',{name:'К списку людей',exact:true}).click();
  await page.getByRole('button',{name:'Следующие люди'}).scrollIntoViewIfNeeded();
  await assertUiLayout(page);
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
