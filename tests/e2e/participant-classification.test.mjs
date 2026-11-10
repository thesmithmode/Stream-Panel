import test from 'node:test';
import assert from 'node:assert/strict';
import {application,seed} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {assertUiLayout} from '../helpers/ui-layout.mjs';

test('stream participants classify inline in compact rows, load one batch, lock linked donors and fit phones',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  const sid=await seed(app),people=await app.db.call('persons'),donor=people.find(p=>p.display_name==='Другой зритель');
  await app.db.call('createDonation',{personId:donor.id,amount:'1',currency:'RUB',occurredAtMs:Date.now(),message:'',sourceName:'Cash'},Date.now());
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(10000);const errors=[],reads=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/persons/'))reads.push(r.url());});
  await goto(page,app.bootstrap());await page.getByRole('button',{name:'Стримы',exact:true}).click();await page.locator(`[data-session-id="${sid}"] .stream-open`).click();await page.getByRole('tab',{name:'Участники',exact:true}).click();
  const rank=page.getByRole('region',{name:'Рейтинг участников'}),row=rank.locator('.participant-row').filter({hasText:'Тестовый зритель'}),locked=rank.locator('.participant-row').filter({hasText:'Другой зритель'});
  await row.getByRole('radio',{name:'Бот',exact:true}).waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('.participant-row .classification')].every(e=>!e.classList.contains('loading')));
  assert.equal(reads.filter(url=>url.includes('/persons/classifications?')).length,1);assert.equal(reads.filter(url=>/\/persons\/[^/?]+\/bot/.test(url)).length,0,'no per-person status requests');
  await locked.locator('.classification-control.locked').waitFor();assert.equal(await locked.getByRole('radio',{name:'Бот',exact:true}).isDisabled(),true);assert.equal(await locked.getByRole('img',{name:/Статус «Человек» закреплён/}).count(),1);
  const before=(await row.boundingBox()).height;
  for(const width of [320,390,1440]){await page.setViewportSize({width,height:900});await assertUiLayout(page);assert.ok((await row.boundingBox()).height<=Math.max(before,60),'classification does not create a second row');const box=await row.locator('.classification').boundingBox();const lockedBox=await locked.locator('.classification').boundingBox();assert.ok(Math.abs(box.x-lockedBox.x)<1,'lock does not shift aligned controls');assert.equal(box.width,59);assert.equal(lockedBox.width,59);assert.ok(box.x>=0&&box.x+box.width<=width);await rank.screenshot({path:`/tmp/sp-participant-classification-${width}.png`});}
  const saved=page.waitForResponse(r=>r.url().endsWith('/classification')&&r.request().method()==='POST'&&r.status()===200);
  await row.getByRole('radio',{name:'Бот',exact:true}).click();await saved;
  const person=people.find(p=>p.display_name==='Тестовый зритель');assert.equal((await app.db.call('personBot',person.id)).manualBot,true);
  const invalid=await page.evaluate(async()=>{const r=await fetch('/api/v1/persons/classifications?'+new URLSearchParams({ids:Array(101).fill('x').join(',')}));return r.status;});assert.equal(invalid,400);
  assert.equal(await page.locator('.person-detail').count(),0,'classification never opens a person card');assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
