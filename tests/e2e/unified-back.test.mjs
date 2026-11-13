import test from 'node:test';
import assert from 'node:assert/strict';
import {application,seed} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,reload,saveCoverage} from '../helpers/browser-coverage.mjs';
import {navigate} from '../helpers/navigation.mjs';

test('one Back follows tabs, directory, reload and Forward; direct person links stay inside the panel',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  const id=await seed(app);browser=await launchBrowser();
  const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();page.setDefaultTimeout(10000);
  await goto(page,app.bootstrap());await navigate(page,'Люди');
  await page.getByLabel('Поиск человека').fill('Тестовый');
  await page.getByRole('region',{name:'Список людей',exact:true}).getByRole('button',{name:'Тестовый зритель',exact:true}).click();const person=new URL(page.url()).searchParams.get('person');
  await page.getByRole('tab',{name:'Заметки',exact:true}).click();await reload(page);
  await page.getByRole('button',{name:'Назад',exact:true}).click();
  await page.getByRole('tab',{name:'Обзор',exact:true}).waitFor();assert.equal(await page.getByRole('tab',{name:'Обзор',exact:true}).getAttribute('aria-selected'),'true');
  await page.getByRole('button',{name:'Все люди',exact:true}).click();await page.getByRole('region',{name:'Список людей',exact:true}).waitFor();
  assert.equal(await page.getByLabel('Поиск человека').inputValue(),'Тестовый');
  await page.getByRole('button',{name:'Назад',exact:true}).click();await page.getByRole('heading',{name:'Тестовый зритель',exact:true}).waitFor();
  await page.getByRole('button',{name:'Назад',exact:true}).click();await page.getByRole('region',{name:'Список людей',exact:true}).waitFor();
  await page.goForward();await page.getByRole('heading',{name:'Тестовый зритель',exact:true}).waitFor();
  await page.setViewportSize({width:1280,height:900});await page.getByRole('link',{name:'Stream Panel',exact:true}).click();await page.locator('.channel-metrics').waitFor();await page.getByRole('button',{name:'Назад',exact:true}).click();await page.getByRole('heading',{name:'Тестовый зритель',exact:true}).waitFor();
  const direct=await context.newPage();direct.setDefaultTimeout(10000);
  await goto(direct,`${app.origin}/?view=people&profile=ruslan&person=${encodeURIComponent(person)}`);
  await direct.getByRole('heading',{name:'Тестовый зритель',exact:true}).waitFor();
  await direct.getByRole('button',{name:'Назад',exact:true}).click();await direct.getByRole('region',{name:'Список людей',exact:true}).waitFor();
  assert.equal(new URL(direct.url()).origin,app.origin);assert.equal(new URL(direct.url()).searchParams.has('person'),false);
  await goto(direct,`${app.origin}/?view=stream&profile=ruslan&stream=${id}`);
  await direct.locator('.stream-kpis').waitFor();await direct.getByRole('button',{name:'Назад',exact:true}).click();await direct.getByRole('region',{name:'История стримов',exact:true}).waitFor();
  // Parent fallback replaces the direct entry; another Back cannot loop into it.
  await direct.getByRole('button',{name:'Назад',exact:true}).click();await direct.locator('.channel-metrics').waitFor();
  await saveCoverage(page,'unified-back');
 }finally{await browser?.close();await app.close();}
});
