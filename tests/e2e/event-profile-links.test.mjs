import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {assertUiLayout} from '../helpers/ui-layout.mjs';

test('event authors open current cards, external profiles use verified addresses and fit desktop and mobile',{timeout:60000},async()=>{
 let calls=0,fail=false;
 const a=await application({twitch:{request:async url=>{
  assert.equal(new URL(url).pathname,'/helix/users');calls++;
  if(fail)return new Response('{}',{status:503});
  return Response.json({data:new URL(url).searchParams.getAll('id').map(id=>({id,login:`login_${id}`}))});
 }}});let browser;
 try{
  a.configuration.value.twitchClientId='client123';a.configuration.value.twitch={access:'fixture',refresh:'fixture',userId:'owner',expiresAt:Date.now()+3600000,scopes:[]};
  const at=Date.now()-60000,sid=await a.db.call('startSession','owner','profiles',at,'platform',at);
  const event=(id,actor)=>({source:'twitch',accountId:'owner',externalId:id,type:'chat.message',actor,occurredAtMs:at+1000,receivedAtMs:at+1000,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'Сообщение '+id}});
  const person=(await a.db.call('ingest',event('one',{externalId:'42',displayName:'Отображаемое имя'}))).personId;
  const solo=(await a.db.call('ingest',event('two',{externalId:'43',displayName:'Отдельный аккаунт'}))).personId;
  await a.db.call('ingest',{...event('anonymous',null),type:'chat.clear'});
  const channelId='UCabcdefghijklmnopqrstuv';
  await a.db.call('attachPlatformStream',sid,'youtube','channel','video',at,at,null,'Profiles');
  await a.db.call('youtubeMessages','channel','chat',[{id:'yt-one',snippet:{type:'textMessageEvent',publishedAt:new Date(at+2000).toISOString(),displayMessage:'YouTube hello'},authorDetails:{channelId,displayName:'YouTube account'}}],'video');
  const yt=(await a.db.call('candidatePersons','YouTube account'))[0];
  await a.db.call('merge',yt,person,(await a.db.call('person',yt)).revision,(await a.db.call('person',person)).revision,at+3000);await a.db.call('renamePerson',person,'Человек');await a.db.call('endSession',sid,at+10000);
  const unauth=await a.app.inject({url:`/api/v1/persons/${person}/platform-links`,headers:{host:new URL(a.origin).host}});assert.equal(unauth.statusCode,401);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],detailRequests=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/\/persons\/[^/]+\/analytics/.test(r.url()))detailRequests.push(r.url());});page.setDefaultTimeout(10000);
  await goto(page,a.bootstrap());await page.getByRole('button',{name:'Стримы',exact:true}).click();await page.locator(`[data-session-id="${sid}"] .stream-open`).click();await page.getByRole('tab',{name:'События',exact:true}).click();
  const archive=page.locator('.recent-events');await archive.getByRole('link',{name:'YouTube account · YouTube',exact:true}).waitFor();
  assert.equal(await archive.getByRole('link',{name:'Без автора · Twitch',exact:true}).count(),0);
  assert.equal(new URL(await archive.getByRole('link',{name:'Отдельный аккаунт · Twitch',exact:true}).getAttribute('href'),a.origin).searchParams.get('person'),solo);
  await archive.getByRole('link',{name:'Отдельный аккаунт · Twitch',exact:true}).focus();await page.keyboard.press('Enter');await page.getByRole('heading',{name:'Отдельный аккаунт',exact:true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('person'),solo);await page.goBack();await page.getByRole('tab',{name:'События',exact:true}).click();
  await archive.getByRole('link',{name:'YouTube account · YouTube',exact:true}).click();await page.getByRole('heading',{name:'Человек',exact:true}).waitFor();assert.equal(new URL(page.url()).searchParams.get('person'),person);
  const twitch=page.getByRole('link',{name:'Открыть Отображаемое имя на Twitch (новая вкладка)',exact:true}),youtube=page.getByRole('link',{name:'Открыть YouTube account на YouTube (новая вкладка)',exact:true});
  await twitch.waitFor();assert.equal(await twitch.getAttribute('href'),'https://www.twitch.tv/login_42');assert.equal(await youtube.getAttribute('href'),`https://www.youtube.com/channel/${channelId}`);assert.equal(await twitch.getAttribute('target'),'_blank');assert.equal(await twitch.getAttribute('rel'),'noopener noreferrer');
  for(const width of [320,390,1280]){await page.setViewportSize({width,height:900});await assertUiLayout(page);}
  const evidence=process.env.STREAM_PANEL_BROWSER_COVERAGE_DIR??'/tmp/stream-panel-qa';await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,'profile-desktop.png'),fullPage:true});
  await page.getByRole('tab',{name:'Аккаунты',exact:true}).click();await twitch.waitFor();
  const checkbox=page.locator('.identity-row input').first();assert.equal(await checkbox.isChecked(),false);
  await page.route('https://www.twitch.tv/**',route=>route.fulfill({contentType:'text/html',body:'<title>Fixture Twitch profile</title>'}));
  const popupPromise=page.waitForEvent('popup');await twitch.click();const popup=await popupPromise;await popup.waitForLoadState();assert.equal(popup.url(),'https://www.twitch.tv/login_42');await popup.close();assert.equal(await checkbox.isChecked(),false);
  await page.setViewportSize({width:390,height:844});await assertUiLayout(page);await page.screenshot({path:join(evidence,'profile-mobile.png'),fullPage:true});
  await page.getByRole('tab',{name:'Сообщения',exact:true}).click();await archive.getByRole('link',{name:'Отображаемое имя · Twitch',exact:true}).waitFor();await archive.getByRole('link',{name:'Отображаемое имя · Twitch',exact:true}).click();assert.equal(new URL(page.url()).searchParams.get('person'),person);
  // Optional URL failures do not prevent opening or reading the local card.
  a.configuration.value.twitch=undefined;await page.reload();await page.getByRole('heading',{name:'Человек',exact:true}).waitFor();await youtube.waitFor();assert.equal(await twitch.count(),0);
  a.configuration.value.twitch={access:'fixture',refresh:'fixture',userId:'different-owner',expiresAt:Date.now()+3600000,scopes:[]};fail=true;
  await page.reload();await page.getByRole('heading',{name:'Человек',exact:true}).waitFor();await youtube.waitFor();assert.equal(await twitch.count(),0);assert.ok(calls>=3);
  assert.deepEqual(detailRequests,[]);assert.equal(await page.title(),'Stream Panel');assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
