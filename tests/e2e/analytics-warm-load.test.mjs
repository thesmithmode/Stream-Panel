import test from 'node:test';import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';import {analyticsSettings} from '../../dist/apps/daemon/src/analytics-settings.js';
test('the real Analytics page opens baked all-history and category reports without preparation responses', {timeout:120000},async()=>{
 const a=await application();let browser;
 try{
  const base=Date.now()-202*86400000;
  for(let n=0;n<201;n++){const at=base+n*86400000,id=await a.db.call('startSession','owner','warm-'+n,at,'platform',at);await a.db.call('streamSample',id,at,'game','Game','',3);await a.db.call('endSession',id,at+60000);}
  const cfg=a.configuration.value,opts={...analyticsSettings(cfg.analyticsSettings),fromMs:0,toMs:Date.now(),excludedLogins:cfg.excludedBotLogins,ownerId:cfg.twitch?.userId??'',youtubeAccount:cfg.youtube?.userId??cfg.youtubeAccountId??''};
  while((await a.db.call('warmAnalytics',opts,true)).preparing){}
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1280,height:900}}),responses=[],errors=[];let clockRequests=0;page.on('request',r=>{if(new URL(r.url()).pathname==='/api/v1/analytics/clock')clockRequests++;});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  page.on('response',r=>{if(new URL(r.url()).pathname==='/api/v1/analytics')responses.push(r.json());});
  await goto(page,a.bootstrap());const start=performance.now();await page.getByRole('button',{name:'Аналитика',exact:true}).click();await page.locator('.activity-clock').waitFor();
  const loadedMs=Math.round(performance.now()-start);await page.getByLabel('Категория донатов',{exact:true}).selectOption('game');await page.waitForFunction(()=>[...document.querySelectorAll('.chart-refresh')].every(el=>!el.textContent.includes('Обновляем')));
  assert.ok(responses.length>=2);for(const data of await Promise.all(responses))assert.notEqual(data.preparing,true,'baked report must not restart preparation');assert.deepEqual(errors,[]);
  assert.equal(clockRequests,0,'opening reports and changing categories must not fetch unselected clock attendance');
  console.log(JSON.stringify({analyticsPage201StreamsMs:loadedMs}));await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
