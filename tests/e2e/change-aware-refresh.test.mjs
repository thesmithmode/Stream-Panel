import test from 'node:test';
import assert from 'node:assert/strict';
import {application,seed} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {navigate} from '../helpers/navigation.mjs';
import {assertUiLayout} from '../helpers/ui-layout.mjs';
test('only the open profile and screen load reports; unchanged offline checks retain snapshots',{timeout:60000},async()=>{
 const a=await application();let browser;
 try{
  const id=await seed(a);await a.db.call('endSession',id,Date.now());
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(10000);
  const reads=[];page.on('request',r=>{const u=new URL(r.url());if(u.pathname.startsWith('/api/v1/'))reads.push({path:u.pathname,profile:r.headers()['x-stream-panel-profile']});});
  await goto(page,a.bootstrap());await page.locator('.channel-metrics').waitFor();
  assert.equal(reads.filter(r=>r.path==='/api/v1/analytics'||r.path==='/api/v1/settings'||r.path==='/api/v1/subscribers').length,0);
  const initial=reads.filter(r=>r.path==='/api/v1/overview').length;
  await page.clock.install();await page.clock.fastForward(301000);
  assert.equal(reads.filter(r=>r.path==='/api/v1/overview').length,initial);
  await navigate(page,'Аналитика');await page.locator('.growth-plot').waitFor();await page.waitForFunction(()=>document.querySelector('.analytics-results')?.getAttribute('aria-busy')==='false');
  const reports=reads.filter(r=>r.path==='/api/v1/analytics').length;
  const checked=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/changes');await page.clock.fastForward(301000);await checked;
  assert.equal(reads.filter(r=>r.path==='/api/v1/analytics').length,reports,'unchanged check does not download a report');
  assert.ok(reads.every(r=>!r.profile||r.profile==='ruslan'));
  for(const width of [320,390,480]){
   await page.setViewportSize({width,height:844});
   const rows=await page.locator('.analytics-toolbar .period-chips button').evaluateAll(buttons=>buttons.map(b=>b.getBoundingClientRect().top));
   assert.equal(rows.length,4);assert.ok(new Set(rows).size<=1,'period controls stay on one row');await assertUiLayout(page);
  }
  await page.screenshot({path:'/tmp/change-aware-analytics-480.png'});await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
