import test from 'node:test';
import assert from 'node:assert/strict';
import {application,seed} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {navigate,withMore} from '../helpers/navigation.mjs';

test('events refresh in place on automatic ticks and profile stays bottom left only on desktop',{timeout:60000},async()=>{
 const a=await application();let browser;
 try{
  const session=await seed(a);browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await goto(page,a.bootstrap());await page.locator('.channel-metrics').waitFor();
  const profile=page.getByLabel('Профиль',{exact:true});const desktop=await profile.boundingBox();assert.ok(desktop.x<200&&desktop.y>800);
  await page.setViewportSize({width:390,height:844});const mobile=await profile.boundingBox();assert.ok(mobile.y<100&&mobile.x>100);await page.screenshot({path:'/tmp/stream-profile-mobile.png'});
  await page.setViewportSize({width:1280,height:900});await navigate(page,'Стримы');await page.locator(`[data-session-id="${session}"] .stream-open`).click();await page.getByRole('tab',{name:'События',exact:true}).click();await page.locator('.recent-events article').first().waitFor();
  await page.clock.install();
  await a.db.call('ingest',{source:'twitch',accountId:'test-channel',externalId:'automatic-event',type:'chat.message',actor:{externalId:'42',displayName:'Тестовый зритель'},occurredAtMs:Date.now(),receivedAtMs:Date.now(),sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'Событие без перезахода'}});
  await page.clock.fastForward(61000);await page.locator('.recent-events').getByText('Событие без перезахода',{exact:true}).waitFor();
  // Even unchanged revisions must revalidate the moving 48-hour archive window.
  let reads=0;page.on('request',r=>{if(new URL(r.url()).pathname==='/api/v1/events/recent')reads++;});const reread=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/events/recent');await page.clock.fastForward(61000);await reread;await page.locator('.recent-events').getByText('Событие без перезахода',{exact:true}).waitFor();assert.ok(reads>0);
  await withMore(page,()=>page.getByRole('button',{name:'Автообновление Вкл',exact:true}).click());const stopped=reads;await page.clock.fastForward(61000);assert.equal(reads,stopped);
  await page.screenshot({path:'/tmp/stream-profile-desktop.png'});assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
