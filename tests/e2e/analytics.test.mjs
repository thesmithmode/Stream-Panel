import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {AccountStore} from '../../dist/apps/daemon/src/auth.js';
import {createHostedApplication} from '../../dist/apps/daemon/src/hosted.js';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
const minute=60000;
test('analytics browser shows core, categories, scoped accounts, minute evidence, configurable thresholds, filters and responsive charts',{timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-analytics-ui-'));
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const origin=`http://127.0.0.1:${port}`,accounts=new AccountStore(join(dir,'data.sqlite'));
 for(const profile of ['ruslan','gulnaz'])await accounts.createUser(profile,profile,profile,`${profile}-analytics-password`);accounts.close();
 const h=await createHostedApplication(dir,origin,false);await h.app.listen({host:'127.0.0.1',port});
 for(const profile of ['ruslan','gulnaz']){
  const runtime=h.runtimes.get(profile),db=runtime.db;
  runtime.configuration.value.twitch={userId:'owner',access:'fixture',refresh:'fixture',expiresAt:Date.now()+3600000,scopes:[]};
  runtime.configuration.value.youtube={userId:'yt-owner',access:'fixture',refresh:'fixture',expiresAt:Date.now()+3600000,scopes:[]};
  for(let n=0;n<3;n++){
   const base=Math.floor((Date.now()-(4-n)*86400000)/minute)*minute,sid=await db.call('startSession','channel',`stream-${n}`,base,'platform',base);
   await db.call('streamSample',sid,base,'game','Game A','Game A title',12);await db.call('streamSample',sid,base+10*minute,'talk','Just Chatting','Talk title',15);await db.call('youtubeViewers',base,4);
   for(const [actor,name] of [['regular',`Regular ${profile}`],['owner','RenamedOwner'],['bot','jeetbot'],['self','fullrandomname_twitch'],['typo','streemelements']])await db.call('ingest',{source:'twitch',accountId:'channel',externalId:`${n}-${actor}`,type:'chat.message',actor:{externalId:actor,displayName:name},occurredAtMs:base+minute,receivedAtMs:base+minute,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}});
   await db.call('recordPoll',sid,'channel',{startedAtMs:base,completedAtMs:base+9*minute,status:'complete',userIds:['regular','owner','bot','self','typo']});
   await db.call('recordPoll',sid,'channel',{startedAtMs:base+12*minute,completedAtMs:base+15*minute,status:'complete',userIds:['regular']});
   await db.call('youtubeMessages','yt-owner',`chat-${n}`,[{id:`yt-${n}`,snippet:{type:'textMessageEvent',publishedAt:new Date(base+minute).toISOString(),displayMessage:'hello'},authorDetails:{channelId:'yt-regular',displayName:`YT ${profile}`}}]);
   await db.call('endSession',sid,base+20*minute,'observed');
  }
 }
 const browser=await launchBrowser();
 try{
  for(const profile of ['ruslan','gulnaz']){
   const context=await browser.newContext();const page=await context.newPage();page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
   const apply=async()=>{await page.getByRole('button',{name:'Применить',exact:true}).click();await page.getByRole('button',{name:'Применить',exact:true}).waitFor();};
   await goto(page,origin);await page.getByLabel('Логин',{exact:true}).fill(profile);await page.getByLabel('Пароль',{exact:true}).fill(`${profile}-analytics-password`);await page.getByRole('button',{name:'Войти',exact:true}).click();
   await page.getByRole('button',{name:'Аналитика',exact:true}).click();await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).waitFor();
   for(const name of ['RenamedOwner','jeetbot','fullrandomname_twitch','streemelements',`Regular ${profile==='ruslan'?'gulnaz':'ruslan'}`])assert.equal(await page.getByRole('button',{name,exact:true}).count(),0);
   await page.getByLabel('Только ядро').check();await page.getByLabel('Поиск участника').fill('Regular');await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).click();
   await page.getByRole('heading',{name:`Активность: Regular ${profile}`}).waitFor();assert.equal(await page.locator('.minute-dot').count(),1440);await page.getByRole('button',{name:'Закрыть детализацию'}).click();
   await page.getByLabel('Поиск участника').fill('');await page.getByLabel('Только ядро').uncheck();
   for(const metric of ['estimated','messages','viewers','observed'])await page.getByLabel('Метрика графика').selectOption(metric);
   await page.getByRole('button',{name:`YT ${profile}`,exact:true}).click();await page.getByText('Оценка по чату YouTube',{exact:true}).first().waitFor();await page.getByRole('button',{name:'Закрыть детализацию'}).click();
   await page.getByText('Как определять ядро аудитории',{exact:true}).click();await page.getByLabel('Минимум эфиров').fill('10');await apply();await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).waitFor();await page.getByLabel('Только ядро').check();await page.getByText('Нет активности по выбранным фильтрам. Сначала нужны собранные эфиры.',{exact:true}).waitFor();
   await page.getByLabel('Только ядро').uncheck();await page.getByLabel('Минимум эфиров').fill('1');await page.getByLabel('Правило ядра').selectOption('both');await page.getByLabel('Часовой пояс сравнения').selectOption('UTC');await page.getByLabel('Категория Twitch').selectOption('game');await apply();await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).waitFor();
   await page.getByLabel('Правило ядра').selectOption('frequency');await page.getByLabel('Площадка').selectOption('youtube');await apply();await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).count(),0);
   await page.getByLabel('Сортировка').selectOption('estimatedChatMinutes');await page.getByLabel('Сортировка').selectOption('sessions');await page.getByLabel('Сортировка').selectOption('messages');
   await page.getByRole('heading',{name:'Возвращения по эфирам',exact:true}).locator('..').locator('..').getByRole('button').first().click();await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();
   await page.getByRole('button',{name:'7 дней',exact:true}).click();await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();
   await page.getByRole('button',{name:'90 дней',exact:true}).click();await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();
   await page.getByLabel('Начало периода').fill('2000-01-01T00:00');await page.getByLabel('Конец периода').fill('2000-01-02T00:00');await apply();await page.getByText('Пока нет точек для графика',{exact:true}).waitFor();
   await page.getByLabel('Начало периода').fill('2000-01-01T00:00');await page.getByLabel('Конец периода').fill('2001-01-01T00:00');await apply();await page.getByRole('alert').filter({hasText:'INVALID_ANALYTICS_FILTER'}).waitFor();
   await page.getByRole('button',{name:'30 дней',exact:true}).click();await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();
   await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await page.setViewportSize({width:1280,height:800});
   await page.getByRole('button',{name:'Демо',exact:true}).click();await page.getByRole('cell',{name:'Демо-игра',exact:true}).waitFor();await page.getByRole('button',{name:'Реальные',exact:true}).click();await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();
   assert.deepEqual(errors,[]);await saveCoverage(page);await context.close();
  }
 }finally{await browser.close();await h.app.close();await rm(dir,{recursive:true,force:true});}
});
