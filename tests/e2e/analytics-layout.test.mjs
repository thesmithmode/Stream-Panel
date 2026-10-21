import test from 'node:test';import assert from 'node:assert/strict';import {mkdir} from 'node:fs/promises';
import {application} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';import {assertUiLayout} from '../helpers/ui-layout.mjs';
test('desktop timing charts share a row; YouTube summary is compact, rounded and newest first',{timeout:60000},async()=>{
 const a=await application();let browser;
 try{
  const at=Date.now()-86400000,sid=await a.db.call('startSession','owner','layout',at,'platform',at);await a.db.call('streamSample',sid,at,'game','Game','',10);await a.db.call('endSession',sid,at+60000);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
  await page.route('**/api/v1/analytics?*',async route=>{const response=await route.fetch(),data=await response.json();if(!data.preparing)data.youtubeReport={updatedAt:at,data:{start:'2026-09-01',end:'2026-10-05',columnHeaders:['day','views','estimatedMinutesWatched','subscribersGained','subscribersLost'].map(name=>({name})),rows:Array.from({length:35},(_,i)=>[new Date(Date.UTC(2026,8,1+i)).toISOString().slice(0,10),10,120.1,2,1])}};await route.fulfill({response,json:data});});
  await goto(page,a.bootstrap());await page.getByRole('button',{name:'Аналитика',exact:true}).click();await page.locator('.youtube-report').waitFor();
  const yt=page.locator('.youtube-report');assert.ok((await yt.locator('.youtube-totals').innerText()).includes('350'));assert.equal(await yt.locator('table').count(),0);
  await yt.getByRole('button',{name:'По дням',exact:true}).click();assert.equal(await yt.locator('tbody tr').count(),30);assert.equal(await yt.locator('tbody tr').first().locator('td').first().innerText(),'2026-10-05');
  await yt.getByRole('button',{name:'Предыдущие дни',exact:true}).click();assert.equal(await yt.locator('tbody tr').count(),5);assert.equal(await yt.locator('tbody tr').first().locator('td').first().innerText(),'2026-09-05');await yt.getByRole('button',{name:'Новые дни',exact:true}).click();await yt.getByRole('button',{name:'Скрыть дни',exact:true}).click();
  assert.ok((await yt.boundingBox()).height<100);await page.getByRole('tab',{name:'Время',exact:true}).click();await page.locator('.time-patterns .pattern-controls>summary').click();await page.locator('.donation-patterns .controls>summary').click();
  for(const width of [1440,1280,1024,390,320]){
   await page.setViewportSize({width,height:1000});await assertUiLayout(page);
   const timing=await page.locator('.time-patterns').boundingBox(),donations=await page.locator('.donation-patterns').boundingBox();
   if(width>1100){
    assert.ok(Math.abs(timing.y-donations.y)<2);assert.ok(Math.abs(timing.height-donations.height)<2);assert.ok(timing.x+timing.width<=donations.x);
    const positions=await page.evaluate(()=>[...document.querySelectorAll('.time-patterns .pattern-row')].map((row,i)=>({left:row.getBoundingClientRect().y,right:document.querySelectorAll('.donation-patterns .bar-row')[i].getBoundingClientRect().y})));
    assert.ok(positions.every(p=>Math.abs(p.left-p.right)<2),JSON.stringify(positions));

    for(const dimension of ['hour','weekday']){
     await page.getByLabel('Сравнение времени',{exact:true}).selectOption(dimension);await page.getByLabel('Группировать донаты',{exact:true}).selectOption(dimension);
     await page.getByLabel('Показатель времени',{exact:true}).selectOption('amount');await page.getByLabel('Показатель донатов',{exact:true}).selectOption('amount');
     const paired=await page.evaluate(()=>[...document.querySelectorAll('.time-patterns .pattern-row')].map((row,i)=>({left:row.getBoundingClientRect().y,right:document.querySelectorAll('.donation-patterns .bar-row')[i].getBoundingClientRect().y})));
     assert.equal(paired.length,dimension==='hour'?24:7);assert.ok(paired.every(p=>Math.abs(p.left-p.right)<2),JSON.stringify(paired));
    }
    await page.getByLabel('Показатель времени',{exact:true}).selectOption('viewers');await page.getByLabel('Показатель донатов',{exact:true}).selectOption('count');
   }else assert.ok(donations.y+donations.height<=timing.y+2);
   if(process.env.STREAM_PANEL_QA_DIR){await mkdir(process.env.STREAM_PANEL_QA_DIR,{recursive:true});await page.screenshot({path:`${process.env.STREAM_PANEL_QA_DIR}/sidebar-${width}.png`});}
   if(process.env.STREAM_PANEL_QA_DIR){await mkdir(process.env.STREAM_PANEL_QA_DIR,{recursive:true});await page.locator('.time-patterns').scrollIntoViewIfNeeded();await page.screenshot({path:`${process.env.STREAM_PANEL_QA_DIR}/timing-${width}.png`});}
  }
  assert.equal(await page.title(),'Stream Panel');assert.ok(page.url().startsWith(a.origin));assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
