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
    if(person.name==='Talkative Viewer'){person.donations={RUB:'22800'};person.accounts=[{source:'twitch',name:'Talkative Twitch'}];}
   }
   await route.fulfill({response,json:data});
  });
  await goto(page,app.bootstrap());
  await page.getByRole('button',{name:'Стримы',exact:true}).click();
  await page.locator(`[data-session-id="${first}"]`).locator('.stream-open').click();
  await page.getByRole('tab',{name:'Участники',exact:true}).click();const rank=page.getByRole('region',{name:'Рейтинг участников'});
  await rank.getByRole('button',{name:'Silent Viewer',exact:true}).waitFor();
  assert.equal(await rank.locator('tbody td:nth-child(2) strong').first().textContent(),'5 мин');
  assert.equal(await rank.locator('.account-details,.accounts').count(),0,'account aliases do not need a disclosure');
  const talkative=rank.locator('.participant-row').filter({has:page.getByRole('button',{name:'Talkative Viewer',exact:true})});
  assert.equal(await talkative.locator('.platform-nicks span').textContent(),'Talkative Twitch','a renamed group shows its platform nickname');
  assert.equal(await talkative.locator('.platform-nicks span').evaluate(el=>getComputedStyle(el).color),'rgb(169, 112, 255)');
  assert.equal(await rank.getByRole('button',{name:'Talkative Viewer',exact:true}).evaluate(el=>getComputedStyle(el).color),'rgb(169, 112, 255)','renamed Twitch participants keep their platform color');
  await assertUiLayout(page);
  assert.equal(await page.locator('.stream-feed').count(),0);
  assert.equal(await page.locator('.following').isVisible(),false,'subscriptions live under the results disclosure');
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
  assert.equal(await rank.getByRole('button',{name:'Silent Twitch',exact:true}).count(),0);
  assert.equal(await rank.getByRole('button',{name:'Silent YouTube',exact:true}).count(),0);
  await rank.getByRole('button',{name:/^Время в чате/}).click();
  assert.equal(await page.getByText('Последний замер:',{exact:false}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Все донаты',exact:true}).count(),0);
  await rank.getByRole('button',{name:'Интервалы Silent Viewer',exact:true}).click();
  const intervals=rank.getByRole('region',{name:'Интервалы Silent Viewer',exact:true});
  assert.equal(await intervals.locator('.twitch').first().evaluate(el=>getComputedStyle(el).color),'rgb(169, 112, 255)');
  assert.equal(await intervals.locator('.youtube').first().evaluate(el=>getComputedStyle(el).color),'rgb(255, 89, 89)');
  await rank.getByText(/Пауза/).waitFor();
  await page.getByRole('tab',{name:'Итоги',exact:true}).click();await page.getByRole('button',{name:'1 мин',exact:true}).click();await page.getByLabel('Показатель графика стрима').selectOption('twitchViewers');
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
    const cards = [...document.querySelectorAll('.stream-kpis > div')].map(c => c.getBoundingClientRect());
    return nav.length === 6 && new Set(nav.map(b=>Math.round(b.top))).size===1 && nav.every(b=>b.left>=0&&b.right<=innerWidth) && cards.length >= 2 && Math.abs(cards[0].top-cards[1].top)<1;
  }), true, 'six mobile destinations fit in one row and metrics use two columns');
  await bars.first().click();await detail.waitFor();
  await detail.getByRole('button',{name:'О детализации минуты',exact:true}).click();
  const help=page.getByRole('dialog',{name:'О детализации минуты'});await help.waitFor();
  const box=await help.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390);
  await page.keyboard.press('Escape');assert.equal(await help.count(),0);
  assert.equal(await page.evaluate(()=>{const nav=document.querySelector('.sidebar').getBoundingClientRect(),main=document.querySelector('main').getBoundingClientRect();return nav.top>=0&&nav.bottom<=innerHeight&&main.height>0;}),true,'mobile navigation must remain above content, not overlay the scrolled chart');
  if(evidence)await page.screenshot({path:join(evidence,'stream-audience-mobile.png'),fullPage:true});
  await assertUiLayout(page);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await detail.getByRole('button',{name:'Silent Viewer',exact:true}).click();
  await page.getByRole('heading',{name:'Silent Viewer',exact:true}).waitFor();
  await page.getByRole('button',{name:'Стримы',exact:true}).click();
  await page.locator(`[data-session-id="${first}"]`).locator('.stream-open').click();
  await page.getByRole('tab',{name:'Участники',exact:true}).click();await rank.getByRole('button',{name:'Silent Viewer',exact:true}).click();
  await page.getByRole('heading',{name:'Silent Viewer',exact:true}).waitFor();
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});

test('historical empty Twitch lists show missing time instead of zero while preserved messages remain visible',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  const base=Date.now()-3600000;
  const missing=await app.db.call('startSession','missing','empty-lists',base,'platform',base);
  for(let i=0;i<8;i++){
   await app.db.call('recordPoll',missing,'missing',{startedAtMs:base+i*60000,completedAtMs:base+i*60000+1000,status:'complete',userIds:[]});
   await app.db.call('ingest',{source:'twitch',accountId:'missing',externalId:'missing-'+i,type:'chat.message',actor:{externalId:'speaker',displayName:'Night Speaker'},occurredAtMs:base+i*60000,receivedAtMs:base+i*60000,timeQuality:'provider',sourceTime:null,transport:'eventsub',payload:{text:'Saved message'}});
  }
  await app.db.call('endSession',missing,base+10*60000);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await goto(page,app.bootstrap());await page.getByRole('button',{name:'Стримы',exact:true}).click();
  await page.locator(`[data-session-id="${missing}"] .stream-open`).click();await page.getByRole('tab',{name:'Участники',exact:true}).click();
  await page.getByText('Сообщения Twitch сохранены, но данных о присутствии участников нет.',{exact:false}).waitFor();
  const row=page.locator('.participant-row').filter({has:page.getByRole('button',{name:'Night Speaker',exact:true})});
  assert.equal(await row.locator('td:nth-child(2)').textContent(),'—');assert.equal(await row.locator('td:nth-child(3)').textContent(),'8');
  assert.equal(await page.title(),'Stream Panel');assert.equal(await page.locator('vite-error-overlay').count(),0);
  await assertUiLayout(page);const evidence=process.env.STREAM_PANEL_BROWSER_COVERAGE_DIR;
  if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,'presence-missing-desktop.png'),fullPage:true});}
  await page.setViewportSize({width:390,height:844});await assertUiLayout(page);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(evidence)await page.screenshot({path:join(evidence,'presence-missing-mobile.png'),fullPage:true});
  await page.getByRole('tab',{name:'Итоги',exact:true}).click();await page.locator('.series-panel').waitFor();
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});

test('participant request failures show an error rather than an empty ranking and reload recovers',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  const base=Date.now()-600000,id=await app.db.call('startSession','failure','failure',base,'platform',base);
  await app.db.call('endSession',id,base+60000);
  browser=await launchBrowser();const page=await browser.newPage();
  await page.route('**/api/v1/sessions/*/metadata',route=>route.abort());
  await goto(page,app.bootstrap());await page.getByRole('button',{name:'Стримы',exact:true}).click();
  await page.locator(`[data-session-id="${id}"] .stream-open`).click();await page.getByRole('tab',{name:'Участники',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Не удалось загрузить участников'}).waitFor();
  assert.equal(await page.getByRole('region',{name:'Рейтинг участников'}).count(),0);
  await page.unroute('**/api/v1/sessions/*/metadata');await page.reload();
  await page.getByRole('tab',{name:'Участники',exact:true}).click();await page.getByRole('region',{name:'Рейтинг участников'}).waitFor();
  assert.equal(await page.getByRole('alert').count(),0);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
