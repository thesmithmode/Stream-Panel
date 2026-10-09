import test from 'node:test';
import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {startCoverage,saveCoverage,goto} from '../helpers/browser-coverage.mjs';

test('YouTube memberships split and undo through the common Person card on mobile without losing events',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  const at=Date.now();
  for(const id of ['one','two'])await app.db.call('youtubeMessages','channel','chat',[{id,snippet:{type:'textMessageEvent',publishedAt:new Date(at).toISOString(),displayMessage:id},authorDetails:{channelId:id,displayName:id}}]);
  const source='youtube:one',other='youtube:two';
  await app.db.call('merge',other,source,(await app.db.call('person',other)).revision,(await app.db.call('person',source)).revision,at);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await startCoverage(page);await goto(page,app.bootstrap());
  await page.getByRole('button',{name:'Люди',exact:true}).click();await page.locator('.person-row').filter({hasText:'one'}).click();
  const identity=page.locator('.identity-row').filter({hasText:'two'});await identity.getByRole('checkbox').check();
  await page.getByLabel('Имя новой группы').fill('Separate YouTube');
  await page.getByRole('button',{name:'Разъединить выбранные',exact:true}).click();
  const split=page.locator('.audit .capability').filter({hasText:'Разъединение'});await split.waitFor();
  assert.equal((await app.db.call('person',source)).identities.length,1);
  await split.getByRole('button',{name:'Отменить',exact:true}).click();
  await page.locator('.audit .capability').filter({hasText:'Отменено'}).waitFor();
  assert.equal((await app.db.call('person',source)).identities.length,2);assert.equal((await app.db.call('events',undefined,source)).length,2);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
