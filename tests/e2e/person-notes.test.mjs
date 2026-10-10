import test from 'node:test';
import assert from 'node:assert/strict';
import {application,seed} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {startCoverage,saveCoverage,goto} from '../helpers/browser-coverage.mjs';

test('person notes support mobile CRUD and return 409 without losing a stale draft', {timeout:60000},async()=>{
 const app=await application();let browser;
 try {
  await seed(app);browser=await launchBrowser();
  const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(10000);
  await startCoverage(page);await goto(page,app.bootstrap());
  await page.getByRole('button',{name:'Люди',exact:true}).click();
  await page.locator('.person-row').filter({hasText:'Тестовый зритель'}).click();
  const section=page.getByRole('region',{name:'Заметки о человеке'});
  await section.getByLabel('Новая заметка').fill('Первая заметка\nВторая строка');
  await section.getByRole('button',{name:'Добавить заметку',exact:true}).click();
  await section.locator('.note-body').filter({hasText:'Первая заметка'}).waitFor();
  const person=(await app.db.call('persons')).find(p=>p.display_name==='Тестовый зритель');
  const note=(await app.db.call('personNotes',person.id))[0];
  const denied=await page.evaluate(async id=>(await fetch(`/api/v1/persons/${id}/notes`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:'Forbidden'})})).status,person.id);
  assert.equal(denied,403);
  await section.getByRole('button',{name:'Редактировать заметку',exact:true}).click();
  await section.getByLabel('Текст заметки').fill('Мой несохранённый текст');
  await app.db.call('updatePersonNote',person.id,note.id,'Из другого окна',0);
  const conflict=page.waitForResponse(r=>r.url().endsWith('/update')&&r.status()===409);
  await section.getByRole('button',{name:'Сохранить заметку',exact:true}).click();await conflict;
  await section.getByRole('alert').filter({hasText:'другом окне'}).waitFor();
  assert.equal(await section.getByLabel('Текст заметки').inputValue(),'Мой несохранённый текст');
  await section.getByRole('button',{name:'Отмена',exact:true}).click();
  await section.getByRole('button',{name:'Редактировать заметку',exact:true}).click();
  await section.getByLabel('Текст заметки').fill('Исправленная заметка');
  await section.getByRole('button',{name:'Сохранить заметку',exact:true}).click();
  await section.locator('.note-body').filter({hasText:'Исправленная заметка'}).waitFor();
  await page.reload();await page.getByRole('button',{name:'Люди',exact:true}).click();
  await page.locator('.person-row').filter({hasText:'Тестовый зритель'}).click();
  await section.locator('.note-body').filter({hasText:'Исправленная заметка'}).waitFor();
  await page.screenshot({path:'/tmp/sp-notes-mobile.png',fullPage:true});
  await section.getByRole('button',{name:'Удалить заметку',exact:true}).click();
  await section.locator('.note-body').waitFor({state:'detached'});
  assert.deepEqual(await app.db.call('personNotes',person.id),[]);
  await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
