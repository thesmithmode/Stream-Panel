import test from 'node:test';import assert from 'node:assert/strict';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {application,seed} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {navigate} from '../helpers/navigation.mjs';
test('unchanged all-time cache survives time passage and activity does not reload subscriber counts',{timeout:60000},async()=>{
const app=await application();let browser;
try {
 const id=await seed(app);await app.db.call('endSession',id,Date.now());browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(10000);
 const calls=[];page.on('request',r=>{const u=new URL(r.url());if(u.pathname==='/api/v1/analytics')calls.push(u.search);});
 await goto(page,app.bootstrap());await page.locator('.channel-metrics').waitFor();await navigate(page,'Аналитика');await page.waitForFunction(()=>document.querySelector('.analytics-results')?.getAttribute('aria-busy')==='false');
 const initial=calls.length;
 await navigate(page,'Обзор');await page.locator('.channel-metrics').waitFor();await navigate(page,'Аналитика');await page.waitForFunction(()=>document.querySelector('.analytics-results')?.getAttribute('aria-busy')==='false');const instant=calls.length;
 await navigate(page,'Обзор');await page.locator('.channel-metrics').waitFor();await page.clock.install();await page.clock.setSystemTime(Date.now()+180000);await navigate(page,'Аналитика');await page.waitForFunction(()=>document.querySelector('.analytics-results')?.getAttribute('aria-busy')==='false');
 assert.equal(instant,initial);assert.equal(calls.length,initial,'passing time alone must not miss the all-time cache');
 const reads=[];page.on('request',r=>reads.push(new URL(r.url()).pathname));
 await app.db.call('streamSample',id,Date.now()-60000,'g','Game','',7);
 const changed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/changes');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await changed;await page.waitForFunction(()=>document.querySelector('.analytics-results')?.getAttribute('aria-busy')==='false');
 assert.equal(reads.filter(p=>p==='/api/v1/analytics/subscribers').length,0);
 for(const [name,path,selector] of [['Люди','/api/v1/persons/page','.person-row'],['Донаты','/api/v1/donations','[data-donation-id]']]){
  await navigate(page,name);await page.locator(selector).first().waitFor();await page.waitForLoadState('networkidle');
  await navigate(page,'Обзор');await page.locator('.channel-records').waitFor();await page.waitForLoadState('networkidle');
  const before=reads.filter(p=>p===path).length;
  await navigate(page,name);await page.locator(selector).first().waitFor();await page.waitForLoadState('networkidle');
  assert.equal(reads.filter(p=>p===path).length,before,`${name} returns from cache without another list request`);
 }
 await saveCoverage(page);
}finally{await browser?.close();await app.close();}

});
