import {mkdir} from 'node:fs/promises';import {join} from 'node:path';
import test from 'node:test';import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';import {assertUiLayout} from '../helpers/ui-layout.mjs';
test('untimed history is visible and can be repaired without leaving the donation screen; mobile controls stay compact',{timeout:90000},async()=>{
 const app=await application();let browser;
 try{
 const at=Date.now()-600000,stamp=new Date(at+120000).toISOString().slice(0,19).replace('T',' '),sid=await app.db.call('startSession','owner','live',at,'platform',at);
 await app.db.call('ingest',{source:'donationalerts',accountId:'da',externalId:'228',type:'donation',actor:{externalId:'name:donor',displayName:'Donor'},occurredAtMs:null,receivedAtMs:at+120000,sourceTime:stamp,timeQuality:'unknown',transport:'rest',payload:{actorName:'Donor',text:'История без потерь',amountMinor:'22800',currency:'RUB'}});
 browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await goto(page,app.bootstrap());
 await page.getByRole('button',{name:'Донаты',exact:true}).click();await page.getByRole('heading',{name:/Все донаты/}).waitFor();await page.getByText('228,00 RUB',{exact:true}).waitFor();await page.getByText('Без привязки к эфиру',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('Часовой пояс дат DA').inputValue(),'','timezone requires evidence rather than silent guessing');
 await page.getByLabel('Часовой пояс дат DA').selectOption('0');await page.getByRole('button',{name:'Применить ко всем донатам',exact:true}).click();await page.getByText('Без привязки к эфиру',{exact:true}).waitFor({state:'hidden'});
 assert.equal((await app.db.call('summary',sid)).totals.RUB,'22800');assert.equal((await app.db.call('donations')).total,1);
 for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});await assertUiLayout(page);}
 await page.setViewportSize({width:320,height:844});await page.getByRole('button',{name:/Автообновление/}).click();await page.getByLabel('Интервал автообновления').waitFor();await assertUiLayout(page);await page.getByLabel('Интервал автообновления').selectOption('60');await page.setViewportSize({width:390,height:844});const footer=await page.locator('.sidebar-bottom').boundingBox();assert.ok(footer.height<80,'fixed controls must not consume the mobile viewport');
 const evidence=process.env.STREAM_PANEL_BROWSER_COVERAGE_DIR;if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,'repaired-donations-mobile.png'),fullPage:true});}assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
