import test from 'node:test';import assert from 'node:assert/strict';import {application} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
test('stream charts retain exact message counts while the event feed contains no message history',{timeout:45000},async()=>{
 const app=await application();let browser;
 try{
  const at=Math.floor((Date.now()-3600000)/60000)*60000,id=await app.db.call('observePlatformStream','twitch','owner','one',at,at,null,'Shared stream');
  await app.db.call('observePlatformStream','youtube','ytowner','yt',at,at,null,'YouTube title');
  const event={source:'twitch',accountId:'owner',externalId:'msg',type:'chat.message',actor:{externalId:'viewer',displayName:'Twitch viewer'},occurredAtMs:at+60000,receivedAtMs:at+60000,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'Twitch message content'}};
  await app.db.call('ingest',event);await app.db.call('ingest',event);
  await app.db.call('ingest',{...event,externalId:'follow',type:'follow',payload:{}});
  await app.db.call('youtubeMessages','ytowner','chat',[{id:'ytmsg',snippet:{type:'textMessageEvent',publishedAt:new Date(at+120000).toISOString(),displayMessage:'YouTube message content'},authorDetails:{channelId:'ytviewer',displayName:'YouTube viewer'}}]);
  await app.db.call('endSession',id,at+180000);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});await goto(page,app.bootstrap());
  await page.getByRole('button',{name:'Стримы',exact:true}).click();await page.locator(`[data-session-id="${id}"]`).locator('.stream-open').click();
  const feed=page.locator('.stream-feed'),messages=page.locator('.stream-kpis > div').filter({hasText:'Сообщения'}).locator('strong');
  await messages.getByText('2',{exact:true}).waitFor();assert.equal(await feed.count(),0);
  await page.getByLabel('Настроить график эфира').click();
  for(const metric of ['messages','twitchMessages','youtubeMessages','viewers','twitchViewers','youtubeViewers']){
   await page.getByLabel('Показатель графика стрима').selectOption(metric);
   assert.equal(await feed.getByText('Twitch message content',{exact:true}).count(),0);assert.equal(await feed.getByText('YouTube message content',{exact:true}).count(),0);
  }
  assert.equal(await page.getByLabel('Фильтр событий').count(),0);
  await page.getByLabel('Показатель графика стрима').selectOption('messages');
  await page.locator('.series-panel .chart-bar').filter({has:page.locator('rect title',{hasText:/всего: 1/})}).first().click();
  await page.getByRole('region',{name:'Детали выбранного столбца'}).waitFor();assert.equal(new URL(page.url()).searchParams.get('stream'),id);
  await page.getByRole('button',{name:'Закрыть детализацию',exact:true}).click();
  assert.equal(await feed.count(),0);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
