import {navigate} from '../helpers/navigation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,startCoverage,saveCoverage,reload} from '../helpers/browser-coverage.mjs';

test('collection diagnostics stay archived without cluttering desktop and mobile screens',{timeout:45000},async()=>{
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
  await navigate(page,'Интеграции');
  assert.equal(await page.getByRole('region',{name:'Пропуски сбора'}).count(),0);
  const archived=await page.evaluate(()=>fetch('/api/v1/status').then(r=>r.json()).then(s=>s.gaps));assert.equal(archived.length,3,'raw collection diagnostics remain archived');
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await reload(page);await navigate(page,'Интеграции');assert.equal(await page.getByRole('region',{name:'Пропуски сбора'}).count(),0);
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
