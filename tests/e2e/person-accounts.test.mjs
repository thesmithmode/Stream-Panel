import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {assertUiLayout} from '../helpers/ui-layout.mjs';
test('one person shows three real platform accounts without duplicate donation assignment rows or an assignment history',{timeout:60000},async()=>{
 const a=await application();let browser;
 try{
  const now=Date.now();
  const person=(await a.db.call('ingest',{source:'twitch',accountId:'owner',externalId:'chat',type:'chat.message',actor:{externalId:'viewer',displayName:'chikist007'},occurredAtMs:now,receivedAtMs:now,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}})).personId;
  await a.db.call('youtubeMessages','channel','chat',[{id:'yt-before',snippet:{type:'textMessageEvent',publishedAt:new Date(now).toISOString()},authorDetails:{channelId:'egor-youtube',displayName:'Егор4ик'}}]);
  const yt=(await a.db.call('candidatePersons','Егор4ик'))[0];
  await a.db.call('merge',yt,person,(await a.db.call('person',yt)).revision,(await a.db.call('person',person)).revision,now);
  await a.db.call('renamePerson',person,'Егор4ик');
  for(const [index,name] of ['Егор4ик','Egor4ik'].entries()){
   await a.db.call('bindDonorNickname',person,name,(await a.db.call('person',person)).revision,now+index);
   await a.db.call('ingest',{source:'donationalerts',accountId:'recipient',externalId:'tip'+index,type:'donation',actor:{externalId:'name:'+name.toLowerCase(),displayName:name},occurredAtMs:now,receivedAtMs:now,sourceTime:null,timeQuality:'provider',transport:'rest',payload:{amountMinor:'10000',currency:'RUB',actorName:name,text:'thanks'}});
  }
  for(const donation of (await a.db.call('donations',person)).items)await a.db.call('reassignDonation',donation.id,person,donation.revision,now+10);
  await a.db.call('youtubeMessages','channel','chat',[{id:'yt-after',snippet:{type:'textMessageEvent',publishedAt:new Date(now+1).toISOString()},authorDetails:{channelId:'egor-youtube',displayName:'@egorbarinov6515'}}]);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await goto(page,a.bootstrap());await page.getByRole('button',{name:'Люди',exact:true}).click();await page.getByLabel('Егор4ик',{exact:true}).click();
  await page.getByRole('heading',{name:'Егор4ик',exact:true}).waitFor();
  await page.getByRole('tab',{name:'Аккаунты',exact:true}).click();await page.getByLabel('Имя человека').waitFor();
  assert.equal(await page.locator('.identity-row').count(),3);assert.equal(await page.locator('.identity-row').filter({hasText:'DonationAlerts'}).count(),1);
  const evidence=process.env.STREAM_PANEL_BROWSER_COVERAGE_DIR;if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,'person-accounts-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await assertUiLayout(page);await page.screenshot({path:join(evidence,'person-accounts-mobile.png'),fullPage:true});await page.setViewportSize({width:1280,height:900});}
  await page.getByLabel('Имя человека').fill('@egorbarinov6515');await page.getByRole('button',{name:'Сохранить',exact:true}).click();await page.getByRole('heading',{name:'@egorbarinov6515',exact:true}).waitFor();
  await a.db.call('youtubeMessages','channel','chat',[{id:'yt-again',snippet:{type:'textMessageEvent',publishedAt:new Date(now+2).toISOString()},authorDetails:{channelId:'egor-youtube',displayName:'New YouTube Name'}}]);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('sp:data-refresh',{detail:{force:true,validated:true}})));
  assert.equal((await a.db.call('person',person)).display_name,'@egorbarinov6515');
  const stats=await a.db.call('personStats',person);assert.equal(stats.donationTotals.RUB,'20000');assert.equal(stats.messageCount,4);
  await page.setViewportSize({width:390,height:844});await assertUiLayout(page);
  await page.getByRole('tab',{name:'Донаты',exact:true}).click();await page.getByRole('heading',{name:'Донаты · 2',exact:true}).waitFor();assert.equal(await page.getByText('История привязок',{exact:true}).count(),0);
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{if(browser)await browser.close();await a.close();}
});
