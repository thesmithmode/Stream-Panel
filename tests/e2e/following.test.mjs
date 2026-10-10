import test from 'node:test';import assert from 'node:assert/strict';import {mkdir} from 'node:fs/promises';import {join} from 'node:path';
import {application} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
test('stream subscriptions show platform totals, exact follow dates and independent current and historical viewer status',{timeout:90000},async()=>{
 const app=await application();let browser;
 try{
  const at=Date.now()-3600000,m=60000,id=await app.db.call('observePlatformStream','twitch','owner','one',at,at,null,'Following stream');
  const result=await app.db.call('ingest',{source:'twitch',accountId:'owner',externalId:'msg',type:'chat.message',actor:{externalId:'viewer',displayName:'Follow Viewer'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}}),person=result.personId;
  await app.db.call('recordPoll',id,'owner',{startedAtMs:at,completedAtMs:at+4*m,status:'complete',userIds:['viewer','silent'],userNames:{viewer:'Follow Viewer',silent:'Silent'}});
  await app.db.call('followingSnapshot','twitch','owner',[],true,at,0);
  await app.db.call('followingSnapshot','twitch','owner',[{id:'viewer',name:'Follow Viewer',followedAtMs:at+m},{id:'unlinked',name:'Unlinked subscriber',followedAtMs:at+2*m}],false,at+3*m,2);
  await app.db.call('youtubeMessages','youtube','chat',[{id:'ytmsg',snippet:{type:'textMessageEvent',publishedAt:new Date(at).toISOString(),displayMessage:'Hi'},authorDetails:{channelId:'author',displayName:'YT Viewer'}}]);
  const yt=(await app.db.call('persons')).find(p=>p.sources==='youtube');await app.db.call('merge',yt.id,person,await app.db.call('personRevision',yt.id),await app.db.call('personRevision',person),at+3*m);
  await app.db.call('followingSnapshot','youtube','youtube',[],true,at+3*m,null);
  await app.db.call('endSession',id,at+4*m);await app.db.call('followingSnapshot','twitch','owner',[],true,at+5*m,0);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await goto(page,app.bootstrap());
  await page.getByRole('button',{name:'Стримы',exact:true}).click();await page.locator(`tr[data-session-id="${id}"]`).getByRole('button',{name:'Открыть',exact:true}).click();
  const following=page.getByRole('region',{name:'Подписки на канал'});await following.getByText('Новых подписок за стрим:',{exact:false}).waitFor();assert.ok((await following.textContent()).includes('Unlinked subscriber'));assert.ok((await following.textContent()).includes('частично'));
  await following.getByRole('button',{name:'О подписках на канал',exact:true}).click();await page.getByRole('dialog',{name:'О подписках на канал'}).waitFor();await page.keyboard.press('Escape');
  await following.getByRole('button',{name:'Follow Viewer',exact:true}).click();await page.getByRole('heading',{name:'Follow Viewer',exact:true}).waitFor();
  const card=page.getByRole('region',{name:'Подписки на канал'});await card.getByText('Подписался во время стрима',{exact:true}).waitFor();
  assert.ok((await card.locator('article').first().textContent()).includes('Не подписан'));assert.ok((await card.locator('article').first().textContent()).includes('Подписан'));assert.ok((await card.locator('article').nth(1).textContent()).includes('Неизвестно'));
  await card.locator('summary').first().click();await card.getByText('Первое сообщение',{exact:true}).first().waitFor();
  const evidence=process.env.STREAM_PANEL_BROWSER_COVERAGE_DIR;if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,'following-mobile.png'),fullPage:true});}
  await page.getByRole('button',{name:'Silent',exact:true}).click();await card.getByText('Сообщений не было',{exact:true}).waitFor();await card.getByText('Дата неизвестна',{exact:true}).waitFor();
  // A follower whose date is private remains positive with an unknown date.
  await app.db.call('followingSnapshot','youtube','youtube',[{id:'author',name:'YT Viewer',followedAtMs:null}],true,at+6*m,null);
  await page.getByRole('button',{name:'Follow Viewer',exact:true}).first().click();await card.getByText('Дата неизвестна',{exact:true}).waitFor();
  const none=await app.db.call('createPerson','No linked account');await page.getByRole('button',{name:'Обзор',exact:true}).click();await page.getByRole('button',{name:'Люди',exact:true}).click();await page.getByRole('button',{name:'No linked account',exact:true}).click();await card.getByText('Нет связанных аккаунтов Twitch или YouTube.',{exact:true}).waitFor();
  await page.route('**/api/v1/persons/*/following?*',route=>route.fulfill({status:400,json:{error:'FOLLOW_CHECK_UNAVAILABLE'}}));await page.getByRole('button',{name:'Silent',exact:true}).click();await card.getByText('FOLLOW_CHECK_UNAVAILABLE',{exact:true}).waitFor();
  assert.ok(new URL(page.url()).searchParams.get('person')!==none.id);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
