import {mkdir} from 'node:fs/promises';import {join} from 'node:path';import test from 'node:test';import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';import {startCoverage,saveCoverage,goto,reload} from '../helpers/browser-coverage.mjs';
test('stream scope never flashes channel totals, reload/back retain the route and a phone recovers from offline without overflowing charts',{timeout:90000},async()=>{
 const app=await application();let browser;
 try{
  const base=Date.now()-5*3600000,m=60000;
  const first=await app.db.call('observePlatformStream','twitch','owner','older',base,base,null,'Older');await app.db.call('endSession',first,base+m);
  await app.db.call('ingest',{source:'donationalerts',accountId:'da',externalId:'tip',type:'donation',occurredAtMs:base,receivedAtMs:base,sourceTime:null,timeQuality:'provider',transport:'rest',payload:{amountMinor:'1200000',currency:'RUB'}});
  const start=base+3600000,id=await app.db.call('observePlatformStream','twitch','owner','current',start,start,null,'Current');
  for(let i=0;i<142;i++)await app.db.call('streamSample',id,start+i*m,'game','Game','Current',10);
  await app.db.call('recordPoll',id,'owner',{startedAtMs:start,completedAtMs:start+141*m,status:'complete',userIds:['viewer'],userNames:{viewer:'Viewer'}});await app.db.call('endSession',id,start+142*m);
  browser=await launchBrowser();const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let bootstrapRequests=0;await page.route('**/api/v1/bootstrap',async route=>{bootstrapRequests++;const response=await route.fetch();await route.fulfill({response,status:502,json:{}});});
  await startCoverage(page);await goto(page,app.bootstrap());
  await page.getByRole('button',{name:'Стримы',exact:true}).waitFor();assert.equal(bootstrapRequests,1);assert.equal(new URL(page.url()).hash,'');
  await page.getByRole('button',{name:'Стримы',exact:true}).click();
  await page.route('**/api/v1/summary?*',async route=>{await new Promise(r=>setTimeout(r,400));await route.continue();});
  await page.locator(`tr[data-session-id="${id}"]`).getByRole('button',{name:'Открыть',exact:true}).click();
  assert.ok(!(await page.locator('main').textContent()).includes('12 000'));
  await page.getByText('Нет донатов',{exact:true}).waitFor();await page.getByText('Среднее число зрителей Twitch',{exact:true}).waitFor();
  assert.equal(await page.getByText('Среднее число зрителей Twitch',{exact:true}).locator('..').locator('strong').textContent(),'10');
  assert.ok(!/\d\.\d{5}/.test(await page.getByText('Полнота наблюдений',{exact:true}).locator('..').textContent()));
  await reload(page);await page.getByText('Нет донатов',{exact:true}).waitFor();assert.ok(new URL(page.url()).searchParams.get('stream')===id);
  const ranking=page.getByRole('region',{name:'Рейтинг участников'});await ranking.getByRole('button',{name:'Viewer',exact:true}).click();await page.getByRole('heading',{name:'Viewer',exact:true}).waitFor();
  await page.goBack();await page.getByText('Нет донатов',{exact:true}).waitFor();await page.goBack();await page.getByRole('heading',{name:'История стримов',exact:true}).waitFor();await page.goForward();await page.getByText('Нет донатов',{exact:true}).waitFor();
  await page.locator('.trend-plot svg').first().waitFor();
  const layout=await page.locator('.trend-plot').first().evaluate(el=>{const svg=el.querySelector('svg'),box=svg.getBoundingClientRect();el.scrollLeft=1000;return {viewport:innerWidth,width:el.clientWidth,scrollWidth:el.scrollWidth,scrollLeft:el.scrollLeft,svgLeft:box.left,svgRight:box.right,barsFit:[...svg.querySelectorAll('.chart-bar rect')].every(bar=>{const r=bar.getBoundingClientRect();return r.left>=box.left-1&&r.right<=box.right+1;})};});
  assert.ok(layout.svgLeft>=0&&layout.svgRight<=layout.viewport&&layout.barsFit,JSON.stringify(layout));assert.equal(layout.scrollLeft,0,JSON.stringify(layout));assert.ok(layout.scrollWidth<=layout.width+1,JSON.stringify(layout));
  await page.getByLabel('Показатель графика стрима').selectOption('observed');await page.locator('.series-panel .chart-bar').first().click();
  await page.getByRole('region',{name:'Детали выбранного столбца'}).waitFor();assert.equal(await page.getByText('Участники по сигналам:',{exact:false}).count(),0);
  const evidence=process.env.STREAM_PANEL_BROWSER_COVERAGE_DIR;if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,'stream-responsive-mobile.png'),fullPage:true});}
  await context.setOffline(true);await page.evaluate(()=>window.dispatchEvent(new Event('offline')));await page.getByText('Связь прервана. Показываем последние загруженные данные.',{exact:true}).waitFor();
  assert.ok(!(await page.locator('main').textContent()).includes('Failed to fetch'));
  await context.setOffline(false);await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForFunction(()=>!document.body.textContent.includes('Связь прервана.'));
  await page.getByRole('button',{name:'Обзор',exact:true}).click();await page.goBack();await page.getByText('Нет донатов',{exact:true}).waitFor();assert.equal(await page.getByLabel('Профиль',{exact:true}).isEnabled(),true);
  assert.deepEqual(errors,[]);await saveCoverage(page,'navigation-resilience');
 }finally{await browser?.close();await app.close();}
});
