import test from 'node:test';import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';import {goto,reload,saveCoverage} from '../helpers/browser-coverage.mjs';import {assertUiLayout} from '../helpers/ui-layout.mjs';
test('stream donation history survives busy chat; suggestions assign one donation; compact profile and default refresh work on desktop and mobile',{timeout:90000},async()=>{
 const app=await application();let browser;try{
 const at=Date.now()-600000,sid=await app.db.call('startSession','owner','live',at,'platform',at);
 const chat=(id,time,name)=>({source:'twitch',accountId:'owner',externalId:id,type:'chat.message',actor:{externalId:name,displayName:name},occurredAtMs:time,receivedAtMs:time,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'Привет'}});
 const viewer=(await app.db.call('ingest',chat('near',at+60000,'Viewer'))).personId;
 const tip={source:'donationalerts',accountId:'da',externalId:'228',type:'donation',actor:{externalId:'name:unknown',displayName:'Unknown'},occurredAtMs:at+120000,receivedAtMs:at+120000,sourceTime:null,timeQuality:'configured',transport:'centrifugo',payload:{actorName:'Unknown',text:'Спасибо за стрим',amountMinor:'22800',currency:'RUB'}};
 await app.db.call('ingest',tip);for(let i=0;i<205;i++)await app.db.call('ingest',chat('later'+i,at+300000+i,'Later'));
 browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await goto(page,app.bootstrap());
 assert.equal(await page.getByRole('button',{name:/Автообновление/}).getAttribute('aria-pressed'),'true');
 await page.getByRole('button',{name:'Стримы',exact:true}).click();await page.locator(`[data-session-id="${sid}"]`).getByRole('button',{name:'Открыть',exact:true}).click();
 const donations=page.getByRole('region',{name:'Донаты стрима'});await donations.getByText('228,00 RUB',{exact:true}).waitFor();await donations.getByRole('button',{name:'Привязать к человеку'}).click();await donations.getByRole('button',{name:/Viewer.*1 сообщ/}).click();await donations.getByRole('button',{name:'Сохранить привязку',exact:true}).click();await donations.getByRole('button',{name:'Связан: Viewer',exact:true}).waitFor();
 assert.equal((await app.db.call('donations',viewer)).total,1);assert.equal((await app.db.call('summary',sid)).totals.RUB,'22800');
 await app.db.call('ingest',{...tip,externalId:'excluded-tip',actor:{externalId:'name:streamelements',displayName:'StreamElements'}});
 await page.evaluate(()=>window.dispatchEvent(new Event('sp:data-refresh')));
 await donations.getByText('В статистике: 1 · Всего записей: 2. Донаты исключённых аккаунтов сохранены в журнале.',{exact:true}).waitFor();
 assert.equal(await page.locator('.stream-feed').count(),0);await donations.getByText('Спасибо за стрим',{exact:true}).waitFor();
 for(const width of [1280,390,320]){await page.setViewportSize({width,height:900});await assertUiLayout(page);}
 await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'/tmp/sp-donations-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/sp-donations-mobile.png',fullPage:true});
 await donations.getByRole('button',{name:'Связан: Viewer',exact:true}).click();await page.getByRole('tab',{name:'Обзор',exact:true}).waitFor();assert.equal(await page.getByLabel('Ник в DonationAlerts').count(),0);assert.equal(await page.locator('.kpi').getByText(/из .*стримов/).count(),0);
 await page.getByRole('button',{name:'Привязать донаты',exact:true}).click();await page.getByLabel('Ник в DonationAlerts').waitFor();
 await page.getByRole('button',{name:'Настройки',exact:true}).click();assert.equal(await page.getByLabel('Порог посещаемости, %').inputValue(),'80');await page.getByLabel('Дополнительное условие ядра').selectOption('frequency');assert.equal(await page.getByLabel('Минимум сообщений').count(),0);await page.getByLabel('Дополнительное условие ядра').selectOption('both');await page.getByLabel('Минимум сообщений').waitFor();
 assert.equal(await page.getByRole('button',{name:/Автообновление/}).getAttribute('aria-pressed'),'true');await reload(page);assert.equal(await page.getByRole('button',{name:/Автообновление/}).getAttribute('aria-pressed'),'true');
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});assert.equal(await page.getByRole('button',{name:/Автообновление/}).getAttribute('aria-pressed'),'true');
 assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
