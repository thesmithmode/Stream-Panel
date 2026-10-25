import test from 'node:test';
import assert from 'node:assert/strict';
import {application,seed} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {setFilter,navigate} from '../helpers/navigation.mjs';
test('leaving a preparing filtered report stops polling and does not show an abort error',{timeout:30000},async()=>{
 const app=await application();let browser;
 try{
  await seed(app);browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(8000);let calls=0;
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/v1/analytics?*',async route=>{
   if(new URL(route.request().url()).searchParams.get('source')!=='twitch')return route.continue();
   calls++;await new Promise(r=>setTimeout(r,40));await route.fulfill({json:{preparing:true}}).catch(()=>{});
  });
  await goto(page,app.bootstrap());await page.getByRole('button',{name:'Аналитика',exact:true}).click();await page.locator('.audience-growth').waitFor();
  const requested=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/v1/analytics'&&new URL(r.url()).searchParams.get('source')==='twitch');
  await setFilter(page,'Площадка','twitch');await requested;
  await navigate(page,'Обзор');await page.locator('.channel-metrics').waitFor();const stopped=calls;
  await page.waitForTimeout(200);assert.equal(calls,stopped,'unmounted report must stop requesting preparation chunks');
  assert.equal(await page.locator('[role="alert"]').count(),0);assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
