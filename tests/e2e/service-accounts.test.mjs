import test from 'node:test';
import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {navigate} from '../helpers/navigation.mjs';
import {assertUiLayout} from '../helpers/ui-layout.mjs';

test('service bots and owner never reappear when bot display changes; stream and analytics agree on desktop and phone',{timeout:90000},async()=>{
 const app=await application();let browser;
 try{
  const at=Date.now()-180000,sid=await app.db.call('startSession','owner','service-ui',at,'platform',at);
  const users=[['owner','HostAccount'],['svc1','JeetBot'],['svc2','Streamer_Bot'],['marked','AudienceBot'],['human','Viewer']];
  for(const [id,name] of users){const person=(await app.db.call('ingest',{source:'twitch',accountId:'owner',externalId:id,type:'chat.message',actor:{externalId:id,displayName:name},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}})).personId;if(id==='marked')await app.db.call('setPersonBot',person,true,(await app.db.call('personBot',person)).revision);}
  await app.db.call('streamSample',sid,at,'game','Game','',11);
  await app.db.call('recordPoll',sid,'owner',{startedAtMs:at,completedAtMs:at+60000,status:'complete',userIds:users.map(([id])=>id)});
  await app.db.call('endSession',sid,at+60000);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await goto(page,app.bootstrap());
  for(const [included,width] of [[true,1440],[false,390]]){
   await page.setViewportSize({width,height:900});await navigate(page,'Настройки');
   await page.getByLabel('Отображать ботов',{exact:true}).setChecked(included);
   const saved=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/settings'&&r.request().method()==='POST'&&r.status()===200);
   await page.getByRole('button',{name:'Сохранить настройки',exact:true}).click();await saved;
   await page.getByText('Настройки профиля сохранены.',{exact:true}).waitFor();
   await navigate(page,'Стримы');await page.locator(`[data-session-id="${sid}"] .stream-open`).click();
   const expected=included?10:9;
   await page.waitForFunction(value=>document.querySelector('.kpi-number')?.textContent===String(value),expected);
   assert.equal((await app.db.call('sessions',sid,0,100,included?false:[]))[0].viewerMean,expected);
   await page.getByRole('tab',{name:'Участники',exact:true}).click();
   await page.getByRole('region',{name:'Рейтинг участников'}).waitFor();
   await page.waitForFunction(n=>document.querySelectorAll('.participant-row').length===n,included?2:1);
   assert.doesNotMatch((await page.locator('.participant-row').allTextContents()).join(' '),/HostAccount|JeetBot|Streamer_Bot/);
   await navigate(page,'Аналитика');await page.getByRole('tab',{name:'Аудитория',exact:true}).click();
   await page.locator('.analytics-results[aria-busy="false"]').waitFor();
   await page.waitForFunction(n=>document.querySelectorAll('.audience-row').length===n,included?2:1);
   assert.doesNotMatch((await page.locator('.audience-row').allTextContents()).join(' '),/HostAccount|JeetBot|Streamer_Bot/);
   await assertUiLayout(page);await page.screenshot({path:`/tmp/sp-service-accounts-${width}.png`,fullPage:true});
  }
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
