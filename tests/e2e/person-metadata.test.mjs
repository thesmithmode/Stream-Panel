import test from 'node:test';
import assert from 'node:assert/strict';
import {application,seed} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {startCoverage,saveCoverage,goto} from '../helpers/browser-coverage.mjs';

test('tags and manual core work on mobile, persist, reject stale changes and agree with analytics',{timeout:60000},async()=>{
 const app=await application();let browser;
 try {
  await seed(app);browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await startCoverage(page);await goto(page,app.bootstrap());
  const open=async()=>{await page.getByRole('button',{name:'Люди',exact:true}).click();await page.locator('.person-row').filter({hasText:'Тестовый зритель'}).click();};
  await open();const form=page.getByRole('region',{name:'Метки человека'});
  await form.getByLabel('Новый тег').fill('Друг');await form.getByRole('button',{name:'Добавить тег',exact:true}).click();
  await form.getByLabel('Ядро аудитории',{exact:true}).selectOption('include');
  const saved=page.waitForResponse(r=>r.url().endsWith('/metadata')&&r.request().method()==='POST'&&r.status()===200);
  await form.getByRole('button',{name:'Сохранить метки',exact:true}).click();await saved;
  const person=(await app.db.call('persons')).find(p=>p.display_name==='Тестовый зритель');
  const metadata=await app.db.call('personMetadata',person.id);assert.deepEqual(metadata.tags,['Друг']);assert.equal(metadata.manualCore,true);
  const denied=await page.evaluate(async id=>(await fetch(`/api/v1/persons/${id}/metadata`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tags:[],manualCore:false,revision:0})})).status,person.id);assert.equal(denied,403);
  await page.getByRole('button',{name:'Аналитика',exact:true}).click();
  const row=page.getByRole('row').filter({hasText:'Тестовый зритель'});await row.locator('.core-badge').filter({hasText:'Ядро'}).waitFor();
  assert.equal(await row.locator('.core-badge').filter({hasText:'Друг'}).count(),1);
  await page.getByLabel('Только ядро').check();assert.equal(await page.getByRole('button',{name:'Другой зритель',exact:true}).count(),0);
  await open();await form.getByRole('button',{name:'Удалить тег Друг',exact:true}).waitFor();
  await form.getByLabel('Новый тег').fill('Собственный черновик');
  await app.db.call('setPersonMetadata',person.id,['Другая вкладка'],false,metadata.revision);
  const conflict=page.waitForResponse(r=>r.url().endsWith('/metadata')&&r.status()===409);
  await form.getByRole('button',{name:'Сохранить метки',exact:true}).click();await conflict;
  await form.getByRole('alert').filter({hasText:'другом окне'}).waitFor();
  assert.equal(await form.getByRole('button',{name:'Удалить тег Собственный черновик',exact:true}).count(),1);
  await form.getByRole('button',{name:'Загрузить актуальные метки',exact:true}).click();
  await form.getByRole('button',{name:'Удалить тег Другая вкладка',exact:true}).waitFor();
  assert.equal(await form.getByLabel('Ядро аудитории',{exact:true}).inputValue(),'exclude');
  await form.getByRole('button',{name:'Удалить тег Другая вкладка',exact:true}).click();
  await form.getByLabel('Ядро аудитории',{exact:true}).selectOption('auto');
  const reset=page.waitForResponse(r=>r.url().endsWith('/metadata')&&r.request().method()==='POST'&&r.status()===200);
  await form.getByRole('button',{name:'Сохранить метки',exact:true}).click();await reset;
  await page.reload();await open();await form.getByLabel('Ядро аудитории',{exact:true}).waitFor();
  assert.equal(await form.getByLabel('Ядро аудитории',{exact:true}).inputValue(),'auto');assert.deepEqual((await app.db.call('personMetadata',person.id)).tags,[]);
  await page.screenshot({path:'/tmp/sp-metadata-mobile.png',fullPage:true});
  await page.setViewportSize({width:1280,height:800});await page.screenshot({path:'/tmp/sp-metadata-desktop.png',fullPage:true});
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
