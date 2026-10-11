import test from 'node:test';import assert from 'node:assert/strict';import {application} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';import {startCoverage,saveCoverage,goto,reload} from '../helpers/browser-coverage.mjs';
test('donation assignment survives reimport, navigation and refresh; detach preserves immutable donation',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  const now=Date.now();for(const [id,name] of [['viewer','Viewer'],['recipient','Recipient']])await app.db.call('youtubeMessages','channel','chat',[{id,snippet:{type:'textMessageEvent',publishedAt:new Date(now).toISOString()},authorDetails:{channelId:id,displayName:name}}]);
  const tip={source:'donationalerts',accountId:'da',externalId:'tip-one',type:'donation',actor:null,occurredAtMs:now,receivedAtMs:now,sourceTime:null,timeQuality:'provider',transport:'rest',payload:{amountMinor:'10000',currency:'RUB',text:'Anonymous one',actorName:''}};
  await app.db.call('ingest',tip);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1280,height:800}});page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await startCoverage(page);await goto(page,app.bootstrap());
  const open=async name=>{await page.getByRole('button',{name:'Люди',exact:true}).click();await page.locator('.person-row').filter({hasText:name}).click();await page.getByRole('tablist',{name:'Разделы человека'}).getByRole('tab',{name:'Донаты',exact:true}).click();};
  await open('Аноним');const section=page.getByRole('region',{name:'Донаты человека'});let row=section.locator('article').filter({hasText:'Anonymous one'});
  assert.equal(await page.getByRole('button',{name:'Добавить человека',exact:true}).count(),0);assert.equal(await section.getByRole('button',{name:'Удалить донат',exact:true}).count(),0);assert.equal(await section.getByLabel('Показать удалённые донаты').count(),0);
  await row.getByRole('button',{name:'Изменить привязку',exact:true}).click();await section.getByLabel('Привязать к человеку',{exact:true}).selectOption('youtube:recipient');await section.getByRole('button',{name:'Сохранить привязку',exact:true}).click();await row.waitFor({state:'detached'});
  const original=(await app.db.call('donations','youtube:recipient')).items[0];assert.equal(original.message,'Anonymous one');assert.equal(original.amountMinor,'10000');
  await app.db.call('ingest',tip);await open('Recipient');row=section.locator('article').filter({hasText:'Anonymous one'});await row.waitFor();await reload(page);await page.getByRole('tablist',{name:'Разделы человека'}).getByRole('tab',{name:'Донаты',exact:true}).click();await row.waitFor();
  assert.equal((await app.db.call('donations')).total,1);assert.equal((await app.db.call('personStats','youtube:recipient')).donationTotals.RUB,'10000');
  await row.getByRole('button',{name:'Изменить привязку',exact:true}).click();await app.db.call('reassignDonation',original.id,'youtube:viewer',1,now+1);
  await section.getByRole('button',{name:'Сохранить привязку',exact:true}).click();await section.getByRole('alert').filter({hasText:'другом окне'}).waitFor();assert.equal(await section.getByLabel('Привязать к человеку').inputValue(),'youtube:recipient');
  await open('Viewer');row=section.locator('article').filter({hasText:'Anonymous one'});await row.getByRole('button',{name:'Открепить от человека',exact:true}).click();await row.waitFor({state:'detached'});
  await open('Аноним');await row.waitFor();assert.equal((await app.db.call('donations')).total,1);assert.equal((await app.db.call('donation',original.id)).revision,3);
  await row.getByText('История привязок',{exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.audit-entry').length===3);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight),true);await page.screenshot({path:'/tmp/sp-donation-desktop.png',fullPage:false});await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'/tmp/sp-donation-mobile.png',fullPage:false});assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
