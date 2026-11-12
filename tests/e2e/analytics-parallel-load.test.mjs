import test from 'node:test';
import assert from 'node:assert/strict';
import {application,seed} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
for(const section of ['dynamics','audience'])test(`authenticated ${section} loads independent data before a delayed report`,{timeout:120000},async()=>{
 const a=await application();let browser,release;
 try{
  const id=await seed(a);await a.db.call('endSession',id,Date.now());
  browser=await launchBrowser();const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
  const blocked=new Promise(resolve=>release=resolve);let held=false,notifyHeld;const reportHeld=new Promise(resolve=>notifyHeld=resolve);
  await page.route('**/api/v1/analytics?*',async route=>{if(!held){held=true;notifyHeld();await blocked;}await route.continue();});
  const parallel=page.waitForRequest(request=>new URL(request.url()).pathname===(section==='dynamics'?'/api/v1/analytics/subscribers':'/api/v1/followers/changes'));
  const url=new URL(a.bootstrap());url.search=new URLSearchParams({view:'analytics',section}).toString();
  await goto(page,url.toString());await Promise.all([parallel,reportHeld]);
  assert.equal(held,true,'main report must still be held while independent request starts');
  release();await page.locator('.analytics-results').waitFor();
  assert.ok((await page.title()).length);assert.ok(await page.locator('#analytics-tabpanel').innerText());assert.deepEqual(errors,[]);
  await page.screenshot({path:`/tmp/sp-${section}-desktop.png`});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:`/tmp/sp-${section}-mobile.png`});
  await saveCoverage(page);
 }finally{release?.();await browser?.close();await a.close();}
});
