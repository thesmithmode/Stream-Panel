import test from 'node:test';
import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {startCoverage,saveCoverage,goto} from '../helpers/browser-coverage.mjs';
test('channel overview filters whole history while stream details and profile data remain separate on mobile',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  const now=Date.now(),streams=[];
  for(const [id,days] of [['old',60],['recent',3]]){
   const start=now-days*86400000,sid=await app.db.call('startSession','channel',id,start,'platform',start);streams.push(sid);
   await app.db.call('ingest',{source:'twitch',accountId:'channel',externalId:id,type:'chat.message',actor:{externalId:'viewer',displayName:'Overview Viewer'},occurredAtMs:start+60000,receivedAtMs:now,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:id}});
   await app.db.call('endSession',sid,start+3600000,'observed');
  }
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await startCoverage(page);await goto(page,app.bootstrap());
  await page.getByRole('heading',{name:'Обзор канала',exact:true}).waitFor();
  const stats=page.getByRole('region',{name:'Статистика канала за период'});
  const count=label=>stats.getByText(label,{exact:true}).locator('..').locator('strong');
  await count('Стримы').filter({hasText:'1'}).waitFor();assert.equal(await count('Сообщения').textContent(),'1');assert.equal(await count('Время эфиров').textContent(),'1 ч');
  assert.equal(await page.getByLabel('Период аналитики').count(),0);
  await page.getByRole('button',{name:'Вся история',exact:true}).click();await count('Стримы').filter({hasText:'2'}).waitFor();assert.equal(await count('Сообщения').textContent(),'2');
  await page.getByRole('button',{name:'7 дней',exact:true}).click();await count('Стримы').filter({hasText:'1'}).waitFor();
  await page.getByRole('button',{name:'Стримы',exact:true}).click();await page.locator(`tr[data-session-id="${streams[0]}"]`).getByRole('button',{name:'Открыть',exact:true}).click();
  await page.getByRole('heading',{name:'Стрим',exact:true}).waitFor();await page.getByRole('heading',{name:'Участники чата',exact:true}).waitFor();
  await page.getByRole('button',{name:'Обзор',exact:true}).click();await page.getByRole('heading',{name:'Обзор канала',exact:true}).waitFor();await count('Стримы').filter({hasText:'1'}).waitFor();
  await page.getByLabel('Профиль',{exact:true}).selectOption('gulnaz');await count('Стримы').filter({hasText:'0'}).waitFor();assert.equal(await count('Сообщения').textContent(),'0');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
