import test from 'node:test';
import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
test('background refresh retains empty people and donation layouts without loading text',{timeout:60000},async()=>{
 const a=await application();let browser;
 try{
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(7000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await goto(page,a.bootstrap());
  for(const [tab,endpoint,loadingText] of [['Люди','persons/page','Загружаем людей…'],['Донаты','donations','Загружаем донаты…']]){
   const initial=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1/${endpoint}`);
   await page.getByRole('button',{name:tab,exact:true}).click();await initial;
   await page.getByText(loadingText,{exact:true}).waitFor({state:'hidden'});
   await page.route(`**/api/v1/${endpoint}?*`,async route=>{const response=await route.fetch();await new Promise(resolve=>setTimeout(resolve,300));await route.fulfill({response});});
   const before=await page.locator('main').boundingBox(),request=page.waitForRequest(r=>new URL(r.url()).pathname===`/api/v1/${endpoint}`),response=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1/${endpoint}`);
   void response.catch(()=>{});
   await page.evaluate(()=>window.dispatchEvent(new Event('sp:data-refresh')));await request;
   assert.equal(await page.getByText(loadingText,{exact:true}).count(),0,`${tab} refresh stays quiet`);
   const during=await page.locator('main').boundingBox();assert.equal(during.height,before.height,`${tab} content keeps its height`);
   await response;
  }
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
