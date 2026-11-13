import test from 'node:test';import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {application,seed} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';import {navigate} from '../helpers/navigation.mjs';import {assertUiLayout} from '../helpers/ui-layout.mjs';
test('retention keeps counts, unknown and zero shares readable with paged rows on phone and desktop',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  await seed(app);browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:900}});page.setDefaultTimeout(10000);
  const pairs=[[18,24],[9,18],[15,20],[6,15],[12,16],[0,10],[0,0]];
  const rows=Array.from({length:21},(_,i)=>({id:`retention-${i}`,startedAt:Date.UTC(2026,10,13-i),returning:pairs[i%7][0],audience:pairs[i%7][1]}));
  await page.route('**/api/v1/analytics?*',async route=>{
   const response=await route.fetch({headers:{...route.request().headers(),'if-none-match':''}}),data=await response.json();
   if(!data.preparing){data.streamRange={first:rows.at(-1).startedAt,total:rows.length};const q=new URL(route.request().url()).searchParams;if(q.has('streamOffset'))data.streamComparison=rows.slice(Number(q.get('streamOffset')),Number(q.get('streamOffset'))+Number(q.get('streamLimit')));}
   await route.fulfill({response,headers:{...response.headers(),etag:''},json:data});
  });
  await goto(page,app.bootstrap());await navigate(page,'Аналитика');await page.locator('.growth-plot').waitFor();
  const card=page.locator('.retention-disclosure');await card.locator('summary').click();
  await page.waitForFunction(()=>document.querySelector('.retention-table tbody')?.textContent.includes('18 из 24'));
  assert.equal(await card.locator('tbody tr').count(),7);assert.match(await card.locator('tbody tr').nth(5).textContent(),/0 из 10.*0 %/);assert.match(await card.locator('tbody tr').nth(6).textContent(),/0 из 0.*Нет данных/);
  assert.equal(await card.getByRole('button',{name:'Предыдущие эфиры',exact:true}).isDisabled(),true);
  await card.getByRole('button',{name:'Следующие эфиры',exact:true}).click();await card.getByText('8–14 из 21',{exact:true}).waitFor();await card.getByRole('button',{name:'Предыдущие эфиры',exact:true}).click();
  await card.getByText('1–7 из 21',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('.retention-table tbody')?.textContent.includes('18 из 24'));
  const shots=process.env.STREAM_PANEL_UI_SCREENSHOTS;
  for(const width of [320,390,1280]){await page.setViewportSize({width,height:1000});await card.evaluate(el=>el.scrollIntoView({block:"start"}));await assertUiLayout(page);assert.equal(await card.locator('table').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);if(shots){await mkdir(shots,{recursive:true});await card.screenshot({path:`${shots}/retention-${width}.png`});}}
  await saveCoverage(page,'retention-layout');
 }finally{await browser?.close();await app.close();}
});
