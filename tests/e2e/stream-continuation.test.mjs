import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {startCoverage,saveCoverage,goto} from '../helpers/browser-coverage.mjs';

test('stream continuation shows Moscow dates, a real break, participant intervals and metadata; each integration has instructions',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  const base=Date.parse('2026-09-13T08:04Z'),m=60000;
  const id=await app.db.call('observePlatformStream','twitch','owner','first',base,base,null,'First title');
  await app.db.call('streamSample',id,base,'game','First game','First title',4);
  await app.db.call('recordPoll',id,'owner',{startedAtMs:base,completedAtMs:base+2*m,status:'complete',userIds:['viewer'],userNames:{viewer:'Silent Viewer'}});
  await app.db.call('endSession',id,base+3*m);
  assert.equal(await app.db.call('observePlatformStream','twitch','owner','second',base+10*m,base+10*m,null,'Second title'),id);
  await app.db.call('streamSample',id,base+10*m,'other','Second game','Second title',5);
  await app.db.call('recordPoll',id,'owner',{startedAtMs:base+10*m,completedAtMs:base+12*m,status:'complete',userIds:['viewer']});
  await app.db.call('endSession',id,base+13*m);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1280,height:850}});page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await startCoverage(page);await goto(page,app.bootstrap());
  await page.getByRole('button',{name:'Стримы',exact:true}).click();
  const row=page.locator(`tr[data-session-id="${id}"]`);assert.ok((await row.textContent()).includes('2026-09-13 11:04 — 2026-09-13 11:17'));
  assert.ok((await row.textContent()).includes('Перерыв: 2026-09-13 11:07 — 2026-09-13 11:14'));
  await row.getByRole('button',{name:'Открыть',exact:true}).click();
  const ranking=page.getByRole('region',{name:'Рейтинг участников'});await ranking.getByRole('button',{name:'Silent Viewer',exact:true}).waitFor();
  assert.equal(await ranking.locator('li strong').first().textContent(),'6 мин');
  await ranking.getByText('Интервалы в чате',{exact:true}).click();
  assert.ok((await ranking.textContent()).includes('2026-09-13 11:04 — 2026-09-13 11:07'));
  assert.ok((await ranking.textContent()).includes('2026-09-13 11:14 — 2026-09-13 11:17'));
  await page.getByText('История названий и категорий',{exact:true}).click();
  assert.ok((await page.locator('.stream-facts').textContent()).includes('First game · First title'));
  assert.ok((await page.locator('.stream-facts').textContent()).includes('Second game · Second title'));
  await page.locator('.series-panel .chart-bar').nth(4).click();assert.ok((await page.getByRole('region',{name:'Детали выбранного столбца'}).textContent()).includes('перерыв'));
  const evidence=process.env.STREAM_PANEL_BROWSER_COVERAGE_DIR;if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,'stream-continuation-desktop.png'),fullPage:true});}
  await page.getByRole('button',{name:'Интеграции',exact:true}).click();
  for(const provider of ['Twitch','DonationAlerts','YouTube']){
   const button=page.getByRole('button',{name:`Инструкция ${provider}`,exact:true});await button.click();
   const guide=page.getByRole('region',{name:`Подключение ${provider}`,exact:true});await guide.waitFor();assert.ok((await guide.textContent()).includes('Client ID'));
   await button.click();assert.equal(await guide.count(),0);await button.click();
  }
  await page.setViewportSize({width:390,height:844});
  if(evidence)await page.screenshot({path:join(evidence,'integration-guides-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
  await saveCoverage(page,'stream-continuation-and-guides');
 }finally{await browser?.close();await app.close();}
});
