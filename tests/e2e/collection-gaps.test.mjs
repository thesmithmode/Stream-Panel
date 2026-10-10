import test from 'node:test';
import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,startCoverage,saveCoverage,reload} from '../helpers/browser-coverage.mjs';

test('collection gaps group repeated failures and expand real intervals on desktop and mobile',{timeout:45000},async()=>{
 const a=await application();let browser;
 try {
  browser=await launchBrowser();
  const page=await browser.newPage({viewport:{width:1280,height:800}});page.setDefaultTimeout(7000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await startCoverage(page);
  const now=Date.now();
  await a.db.call('gap','twitch','connection_lost_no_replay',now-600000,now-540000);
  await a.db.call('gap','twitch','connection_lost_no_replay',now-300000,now-240000);
  await a.db.call('gap','twitch','chatters_poll_failed',now-120000,null);
  await goto(page,a.bootstrap());
  await page.getByRole('navigation').getByRole('button',{name:'Интеграции',exact:true}).click();
  const region=page.getByRole('region',{name:'Пропуски сбора'});
  await region.getByRole('heading',{name:'Пропуски сбора'}).waitFor();
  assert.equal(await region.locator('details').count(),2);
  const connection=region.locator('details').filter({hasText:'Разрыв соединения'});
  await connection.locator('summary').click();
  assert.equal(await connection.locator('li:visible').count(),2);
  await connection.getByText(new Date(now-600000).toLocaleString('ru-RU'),{exact:true}).waitFor();
  await connection.getByText(new Date(now-300000).toLocaleString('ru-RU'),{exact:true}).waitFor();
  await region.scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/sp-gaps-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  const failed=region.locator('details').filter({hasText:'Не удалось опросить'});
  await failed.locator('summary').click();await failed.getByText('Окончание не установлено',{exact:false}).waitFor();
  await region.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'/tmp/sp-gaps-mobile.png'});
  await reload(page);await page.getByRole('navigation').getByRole('button',{name:'Интеграции',exact:true}).click();
  await page.getByRole('region',{name:'Пропуски сбора'}).locator('details').first().waitFor();
  assert.equal(await page.getByRole('region',{name:'Пропуски сбора'}).locator('details').count(),2);
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
