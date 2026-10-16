import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {assertUiLayout} from '../helpers/ui-layout.mjs';

test('stream audience ranks silent minutes, selects exact minute members, and supports touch and keyboard',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  const minute=60000,base=Math.floor((Date.now()-3600000)/minute)*minute;
  const first=await app.db.call('startSession','a','audience-first',base,'platform',base);
  const other=await app.db.call('startSession','b','audience-other',base,'platform',base);
  await app.db.call('recordPoll',first,'a',{startedAtMs:base,completedAtMs:base+2*minute,status:'complete',userIds:['silent','talker','streamelements'],userNames:{silent:'Silent Viewer',talker:'Talkative Viewer'}});
  await app.db.call('recordPoll',first,'a',{startedAtMs:base+3*minute,completedAtMs:base+4*minute,status:'failed',userIds:['silent']});
  await app.db.call('recordPoll',first,'a',{startedAtMs:base+5*minute,completedAtMs:base+6*minute,status:'complete',userIds:['silent']});
  await app.db.call('recordPoll',other,'b',{startedAtMs:base,completedAtMs:base+9*minute,status:'complete',userIds:['other'],userNames:{other:'Other Stream Viewer'}});
  for(let i=0;i<4;i++)await app.db.call('ingest',{source:'twitch',accountId:'a',externalId:`rank-message-${i}`,type:'chat.message',actor:{externalId:'talker',displayName:'Talkative Viewer'},occurredAtMs:base+minute,receivedAtMs:base+minute,timeQuality:'provider',sourceTime:null,transport:'eventsub',payload:{text:'hello'}});
  await app.db.call('ingest',{source:'twitch',accountId:'a',externalId:'audience-raid',type:'channel.raid',actor:null,occurredAtMs:base+minute,receivedAtMs:base+minute,timeQuality:'provider',sourceTime:null,transport:'eventsub',payload:{viewers:1}});
  await app.db.call('endSession',first,base+10*minute,'observed');await app.db.call('endSession',other,base+10*minute,'observed');
  browser=await launchBrowser();
  const page=await browser.newPage({viewport:{width:1280,height:800}});page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/v1/analytics?*',async route=>{
   const response=await route.fetch(),data=await response.json();
   for(const person of data.audience??[]){
    if(person.name==='Silent Viewer'){person.accounts=[{source:'twitch',name:'Silent Twitch'},{source:'youtube',name:'Silent YouTube'}];person.donations={EUR:'500'};person.intervals.push({from:base,to:base+minute,kind:'chat_proxy'});}
    if(person.name==='Talkative Viewer')person.donations={RUB:'22800'};
   }
   await route.fulfill({response,json:data});
  });
  await goto(page,app.bootstrap());
  await page.getByRole('button',{name:'Стримы',exact:true}).click();
  await page.locator(`tr[data-session-id="${first}"]`).getByRole('button',{name:'Открыть',exact:true}).click();
  const rank=page.getByRole('region',{name:'Рейтинг участников'});
  await rank.getByRole('button',{name:'Silent Viewer',exact:true}).waitFor();
  assert.equal(await rank.locator('tbody td:nth-child(2) strong').first().textContent(),'5 мин');
  await assertUiLayout(page);
  assert.equal(await page.locator('.stream-feed').count(),0);
  assert.equal(await page.evaluate(() => {
    const panels = [...document.querySelectorAll('.stream-details-grid > .panel')].map(p => p.getBoundingClientRect());
    return panels.length === 2 && panels[0].bottom <= panels[1].top;
  }), true, 'audience table and follower panel align vertically');
  assert.ok((await rank.locator('tbody tr').nth(1).textContent()).includes('3 мин'));
  assert.equal(await rank.getByRole('button',{name:'Other Stream Viewer',exact:true}).count(),0);
  assert.equal(await rank.getByRole('button',{name:'streamelements',exact:true}).count(),0);
  await rank.getByRole('button',{name:/^Сообщения/}).click();
  assert.equal(await rank.locator('tbody td:nth-child(3)').first().textContent(),'4');
  assert.equal(await rank.getByRole('button',{name:'Silent Viewer',exact:true}).count(),1);
  await rank.getByRole('button',{name:/^Сообщения/}).click();
  assert.equal(await rank.locator('tbody td:nth-child(3)').first().textContent(),'0');
  await rank.getByRole('button',{name:/^Участник/}).click();await rank.getByRole('button',{name:/^Участник/}).click();
  await rank.getByRole('button',{name:'Донаты, RUB',exact:false}).click();
  assert.equal(await rank.locator('tbody td:first-child').first().getByRole('button',{name:'Talkative Viewer',exact:true}).count(),1);
  await rank.getByRole('button',{name:'Донаты, EUR',exact:false}).click();
  assert.equal(await rank.getByRole('button',{name:'Silent Twitch',exact:true}).evaluate(el=>getComputedStyle(el).color),'rgb(169, 112, 255)');
  assert.equal(await rank.getByRole('button',{name:'Silent YouTube',exact:true}).evaluate(el=>getComputedStyle(el).color),'rgb(255, 89, 89)');
  await rank.getByRole('button',{name:/^Время в эфире/}).click();
  assert.equal(await page.getByText('Последний замер:',{exact:false}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Все донаты',exact:true}).count(),0);
  await rank.locator('tbody tr').first().getByText('Интервалы',{exact:true}).click();
  await rank.getByText(/Пауза/).waitFor();
  await page.getByLabel('Показатель графика стрима').selectOption('twitchViewers');
  const bars=page.locator('.series-panel .chart-bar');
  await bars.first().click();
  const detail=page.getByRole('region',{name:'Детали выбранного столбца'});
  await detail.waitFor();
  const evidence=process.env.STREAM_PANEL_BROWSER_COVERAGE_DIR;
  if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,'stream-audience-desktop.png'),fullPage:true});}
  assert.equal(await detail.getByRole('button',{name:'Silent Viewer',exact:true}).count(),1);
  assert.equal(await detail.getByRole('button',{name:'Talkative Viewer',exact:true}).count(),1);
  assert.equal(await detail.getByRole('button',{name:'Other Stream Viewer',exact:true}).count(),0);
  await page.getByRole('button',{name:'Закрыть детализацию',exact:true}).click();
  await bars.nth(5).focus();await page.keyboard.press('Enter');await detail.waitFor();
  assert.equal(await detail.getByRole('button',{name:'Silent Viewer',exact:true}).count(),1);
  assert.equal(await detail.getByRole('button',{name:'Talkative Viewer',exact:true}).count(),0);
  await page.getByRole('button',{name:'Закрыть детализацию',exact:true}).click();
  await bars.nth(3).click();assert.ok((await detail.textContent()).includes('нет данных'));
  assert.equal(await detail.getByRole('button',{name:'Silent Viewer',exact:true}).count(),0);
  await page.getByRole('button',{name:'Закрыть детализацию',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('.stream-feed').count(),0);
  assert.equal(await page.evaluate(() => {
    const nav = [...document.querySelectorAll('.sidebar nav button')].map(b => b.getBoundingClientRect());
    const cards = [...document.querySelectorAll('.stream-metrics .metric')].map(c => c.getBoundingClientRect());
    return nav.length === 7 && new Set(nav.map(b=>Math.round(b.top))).size===2 && nav.every(b=>b.left>=0&&b.right<=innerWidth) && cards.length >= 2 && Math.abs(cards[0].top-cards[1].top)<1;
  }), true, 'all seven mobile destinations fit in two rows and metrics use two columns');
  await bars.first().click();await detail.waitFor();
  await detail.getByRole('button',{name:'О детализации минуты',exact:true}).click();
  const help=page.getByRole('dialog',{name:'О детализации минуты'});await help.waitFor();
  const box=await help.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390);
  await page.keyboard.press('Escape');assert.equal(await help.count(),0);
  assert.equal(await page.evaluate(()=>{const nav=document.querySelector('.sidebar').getBoundingClientRect(),main=document.querySelector('main').getBoundingClientRect();return nav.bottom<=main.top+.5;}),true,'mobile navigation must remain above content, not overlay the scrolled chart');
  if(evidence)await page.screenshot({path:join(evidence,'stream-audience-mobile.png'),fullPage:true});
  await assertUiLayout(page);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await detail.getByRole('button',{name:'Silent Viewer',exact:true}).click();
  await page.getByRole('heading',{name:'Silent Viewer',exact:true}).waitFor();
  await page.getByRole('button',{name:'Стримы',exact:true}).click();
  await page.locator(`tr[data-session-id="${first}"]`).getByRole('button',{name:'Открыть',exact:true}).click();
  await rank.getByRole('button',{name:'Silent Viewer',exact:true}).click();
  await page.getByRole('heading',{name:'Silent Viewer',exact:true}).waitFor();
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
