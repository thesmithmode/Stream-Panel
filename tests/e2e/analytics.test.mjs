import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {AccountStore} from '../../dist/apps/daemon/src/auth.js';
import {createHostedApplication} from '../../dist/apps/daemon/src/hosted.js';
import {assertUiLayout} from '../helpers/ui-layout.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
const minute=60000;
test('analytics browser shows core defaults, categories, scoped accounts, minute evidence, automatic filters and responsive charts',{timeout:90000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-analytics-ui-'));
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const origin=`http://127.0.0.1:${port}`,accounts=new AccountStore(join(dir,'data.sqlite'));
 for(const profile of ['ruslan','gulnaz'])await accounts.createUser(profile,profile,profile,`${profile}-analytics-password`);accounts.close();
 const h=await createHostedApplication(dir,origin,false);await h.app.listen({host:'127.0.0.1',port});
 for(const profile of ['ruslan','gulnaz']){
  const runtime=h.runtimes.get(profile),db=runtime.db;
  runtime.configuration.value.twitch={userId:'owner',access:'fixture',refresh:'fixture',expiresAt:Date.now()+3600000,scopes:[]};
  await db.call('youtubeSnapshot','yt-owner','report',{start:'2026-10-01',end:'2026-10-06',columnHeaders:[{name:'day'},{name:'estimatedMinutesWatched'}],rows:[['2026-10-06',123]]},Date.now());
  runtime.configuration.value.youtube={userId:'yt-owner',access:'fixture',refresh:'fixture',expiresAt:Date.now()+3600000,scopes:[]};
  for(let n=0;n<3;n++){
   const base=Math.floor((Date.now()-(4-n)*86400000)/minute)*minute,sid=await db.call('startSession','channel',`stream-${n}`,base,'platform',base);
   await db.call('streamSample',sid,base,'game','Game A','Game A title',12);await db.call('streamSample',sid,base+10*minute,'talk','Just Chatting','Talk title',15);await db.call('youtubeViewers',base,4);
   for(const [actor,name] of [['regular',`Regular ${profile}`],...(n===0?[['casual',`Occasional ${profile}`]]:[]),['owner','RenamedOwner'],['bot','jeetbot'],['self','fullrandomname_twitch'],['typo','streemelements']])await db.call('ingest',{source:'twitch',accountId:'channel',externalId:`${n}-${actor}`,type:'chat.message',actor:{externalId:actor,displayName:name},occurredAtMs:base+minute,receivedAtMs:base+minute,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}});
   await db.call('ingest',{source:'donationalerts',accountId:'da',externalId:`tip-${n}`,type:'donation',actor:{externalId:`name:regular ${profile}`,displayName:`Regular ${profile}`},occurredAtMs:base+minute,receivedAtMs:base+minute,sourceTime:null,timeQuality:'configured',transport:'rest',payload:{amountMinor:'100',currency:'RUB'}});
   await db.call('recordPoll',sid,'channel',{startedAtMs:base,completedAtMs:base+9*minute,status:'complete',userIds:['regular','owner','bot','self','typo',...(n===0?['casual']:[])]});
   await db.call('recordPoll',sid,'channel',{startedAtMs:base+12*minute,completedAtMs:base+15*minute,status:'complete',userIds:['regular']});
   await db.call('youtubeMessages','yt-owner',`chat-${n}`,[{id:`yt-${n}`,snippet:{type:'textMessageEvent',publishedAt:new Date(base+minute).toISOString(),displayMessage:'hello'},authorDetails:{channelId:'yt-regular',displayName:`YT ${profile}`}}]);
   await db.call('endSession',sid,base+20*minute,'observed');
  }
 }
 const browser=await launchBrowser();
 try{
  for(const profile of ['ruslan','gulnaz']){
   const context=await browser.newContext();const page=await context.newPage();await page.clock.install();page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
   const watchAnalytics=(query,status=200,extra=()=>true)=>page.waitForResponse(response=>{
    const url=new URL(response.url());
    return url.pathname==='/api/v1/analytics'&&response.status()===status&&Object.entries(query).every(([key,value])=>url.searchParams.get(key)===String(value))&&extra(url);
   });
   const advanceAutoFilter=async(response)=>{await page.clock.fastForward(300);return response;};
   const openAnalytics=async(query)=>{const response=watchAnalytics(query);await page.getByRole('button',{name:'Аналитика',exact:true}).click();await advanceAutoFilter(response);};
   const currentPeriod=async(values)=>page.evaluate(inputs=>Object.fromEntries(inputs.map(([key,value])=>[key,String(new Date(value).getTime())])),values);
   const presetPeriod=async(days)=>page.evaluate(span=>{
    const localInput=at=>{const d=new Date(at);return new Date(at-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
    return {from:String(new Date(localInput(span==='all'?0:Date.now()-span*86400000)).getTime()),to:String(new Date(localInput(Date.now())).getTime())};
   },days);
   await goto(page,origin);await page.getByLabel('Логин',{exact:true}).fill(profile);await page.getByLabel('Пароль',{exact:true}).fill(`${profile}-analytics-password`);await page.getByRole('button',{name:'Войти',exact:true}).click();
   await openAnalytics({source:'all',category:'',timezone:'Europe/Moscow'});await page.getByRole('heading',{name:'Агрегатный отчёт YouTube: все видео канала',exact:true}).waitFor();await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).waitFor();
   assert.equal(await page.getByRole('button',{name:'Применить',exact:true}).count(),0);
   for(const label of ['Порог постоянника, % посещений','Минимум эфиров','Минимум минут активности','Минимум сообщений','Правило ядра','Окно активности YouTube, мин'])assert.equal(await page.getByLabel(label,{exact:true}).count(),0,label);
   assert.equal(await page.getByText('Как определять ядро аудитории',{exact:true}).count(),0);
   for(const name of ['RenamedOwner','jeetbot','fullrandomname_twitch','streemelements',`Regular ${profile==='ruslan'?'gulnaz':'ruslan'}`])assert.equal(await page.getByRole('button',{name,exact:true}).count(),0);
   await page.getByText('Настроить отображение',{exact:true}).click();await page.getByLabel('Детализация графика').selectOption('1');await page.locator('.regular-segment').first().waitFor();await page.getByText('Настроить отображение',{exact:true}).click();
   assert.ok(await page.locator('.trend-chart rect.regular-segment').count()>0);
   assert.ok(await page.locator('.trend-chart .chart-bar').evaluateAll(groups=>groups.some(group=>{const full=group.querySelector('.total-segment'),regular=group.querySelector('.regular-segment');return regular&&Math.abs(Number(regular.getAttribute('height'))/Number(full.getAttribute('height'))-.5)<.001&&Math.abs(Number(regular.getAttribute('y'))+Number(regular.getAttribute('height'))-190)<.001;})));
   assert.ok(await page.getByRole('row').filter({hasText:`Regular ${profile}`}).locator('.regular-badge').count()>0);
   assert.equal(await page.getByRole('row').filter({hasText:`Occasional ${profile}`}).locator('.regular-badge').count(),0);
   await page.getByLabel('Метрика графика').selectOption('viewers');assert.equal(await page.locator('.trend-chart rect.regular-segment').count(),0);await page.getByLabel('Метрика графика').selectOption('observed');
   await page.getByText('Настроить отображение',{exact:true}).click();
   await page.getByLabel('Детализация графика').selectOption('15');
   assert.ok((await page.locator('.trend-chart .chart-bar title').first().textContent()).includes('15 мин'));
   await page.getByLabel('Жёлтая доля постоянников').uncheck();assert.equal(await page.locator('.regular-segment').count(),0);
   await page.getByLabel('Только постоянники').check();assert.equal(await page.getByRole('button',{name:`Occasional ${profile}`,exact:true}).count(),0);
   await page.getByLabel('Сортировка').selectOption('attendanceRatio');
   await page.getByLabel('Вид дней и часов').selectOption('table');assert.equal(await page.locator('.hour-heatmap').count(),0);
   await page.getByLabel('Вид дней и часов').selectOption('map');assert.equal(await page.locator('.hour-heatmap').count(),1);
   const sections=[['Отчёт YouTube','Агрегатный отчёт YouTube: все видео канала'],['График активности','Активность по времени'],['Сравнение категорий','Что стримить: категории'],['Дни и часы','Когда стримить: дни и часы'],['Возвращения по эфирам','Возвращения по эфирам'],['Таблица аудитории','Состав аудитории']];
   for(const [label,heading] of sections){await page.getByLabel(label,{exact:true}).uncheck();assert.equal(await page.getByRole('heading',{name:heading,exact:true}).count(),0);await page.getByLabel(label,{exact:true}).check();}
   await page.getByLabel('График активности',{exact:true}).uncheck();
   await page.getByRole('button',{name:'Обзор',exact:true}).click();await openAnalytics({source:'all',category:'',timezone:'Europe/Moscow'});await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).waitFor();
   assert.equal(await page.getByRole('heading',{name:'Активность по времени',exact:true}).count(),0);
   await page.getByText('Настроить отображение',{exact:true}).click();
   assert.equal(await page.getByLabel('Детализация графика').inputValue(),'15');assert.equal(await page.getByLabel('Только постоянники').isChecked(),true);
   await page.getByRole('button',{name:'Сбросить отображение',exact:true}).click();await page.getByRole('heading',{name:'Активность по времени',exact:true}).waitFor();
   assert.equal(await page.getByLabel('Только постоянники').isChecked(),false);assert.ok(await page.locator('.regular-segment').count()>0);
   if(profile==='ruslan'){
    for(const width of [320,390,768,1280,1440]){
     await page.setViewportSize({width,height:900});
     for(const tab of ['Обзор','Стримы','Люди','Аналитика','YouTube','Интеграции']){
      if(tab==='Аналитика')await openAnalytics({source:'all',category:'',timezone:'Europe/Moscow'});
      else await page.getByRole('button',{name:tab,exact:true}).click();await page.locator('main h1').waitFor();
      if(tab==='Аналитика')await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).waitFor();
      if(tab==='Аналитика'){
       await page.getByText('Настроить отображение',{exact:true}).click();
       await page.evaluate(()=>window.scrollTo(0,0));
      }
      await assertUiLayout(page);
     }
    }
    await page.setViewportSize({width:1280,height:800});await openAnalytics({source:'all',category:'',timezone:'Europe/Moscow'});await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).waitFor();
   }
   await page.getByLabel('Только ядро').check();
   const defaultCoreCount=Number(await page.locator('.metrics .metric').filter({hasText:'Ядро аудитории'}).locator('strong').textContent());
   const audienceSection=page.getByRole('heading',{name:'Состав аудитории',exact:true}).locator('..').locator('..');
   const visibleCoreRows=await audienceSection.locator('.analytics-table tbody tr').count();
   assert.equal(visibleCoreRows,defaultCoreCount,'core-only filter must use default-qualified audience');
   assert.equal(await audienceSection.locator('.analytics-table tbody tr').evaluateAll(rows=>rows.every(row=>row.querySelector('.core-badge'))),true);
   await page.getByLabel('Только ядро').uncheck();
   await page.getByLabel('Поиск участника').fill('Regular');await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).click();
   await page.getByRole('heading',{name:`Активность: Regular ${profile}`}).waitFor();assert.equal(await page.locator('.minute-dot').count(),1440);await page.getByRole('button',{name:'Закрыть детализацию'}).click();
   await page.getByLabel('Поиск участника').fill('');
   for(const metric of ['estimated','messages','viewers','observed']){await page.getByLabel('Метрика графика').selectOption(metric);await page.getByLabel('Метрика карты').selectOption(metric);if(metric!=='viewers')assert.ok(await page.locator('.trend-chart rect.regular-segment').count()>0);}
   await page.getByLabel('Обновлять каждую минуту').check();
   const refreshed=page.waitForResponse(r=>r.url().includes('/api/v1/analytics?')&&r.status()===200);await page.clock.fastForward(60300);await refreshed;await page.getByLabel('Обновлять каждую минуту').uncheck();
   await page.getByRole('button',{name:`YT ${profile}`,exact:true}).click();await page.getByText('Оценка по чату YouTube',{exact:true}).first().waitFor();await page.getByRole('button',{name:'Закрыть детализацию'}).click();
   const autoFilter=watchAnalytics({source:'all',category:'game',timezone:'UTC'});
   await page.getByLabel('Часовой пояс сравнения').selectOption('UTC');await page.getByLabel('Категория Twitch').selectOption('game');await advanceAutoFilter(autoFilter);
   await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).waitFor();
   const youtubeFilter=watchAnalytics({source:'youtube',category:'game',timezone:'UTC'});
   await page.getByLabel('Площадка').selectOption('youtube');await advanceAutoFilter(youtubeFilter);
   await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).count(),0);
   const twitchFilter=watchAnalytics({source:'twitch',category:'game',timezone:'UTC'});
   await page.getByLabel('Площадка').selectOption('twitch');await advanceAutoFilter(twitchFilter);
   await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).click();await page.getByText('Донаты с подтверждённым временем:',{exact:false}).first().waitFor();await page.getByRole('button',{name:'Открыть карточку человека',exact:true}).click();await openAnalytics({source:'all',category:'',timezone:'UTC'});await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).waitFor();
   await page.getByRole('button',{name:'Обзор',exact:true}).click();await openAnalytics({source:'all',category:'',timezone:'UTC'});await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).waitFor();
   const youtubeAgain=watchAnalytics({source:'youtube',category:'',timezone:'UTC'});
   await page.getByLabel('Площадка').selectOption('youtube');await advanceAutoFilter(youtubeAgain);await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();
   await page.getByLabel('Сортировка').selectOption('estimatedChatMinutes');await page.getByLabel('Сортировка').selectOption('sessions');await page.getByLabel('Сортировка').selectOption('messages');
   const streamFilter=watchAnalytics({source:'youtube',category:'',timezone:'UTC'},200,url=>Number(url.searchParams.get('to'))-Number(url.searchParams.get('from'))===20*minute);
   await page.getByRole('heading',{name:'Возвращения по эфирам',exact:true}).locator('..').locator('..').getByRole('button').first().click();await advanceAutoFilter(streamFilter);await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();
   const weekRange=await presetPeriod(7),weekFilter=watchAnalytics({source:'youtube',category:'',timezone:'UTC',...weekRange});
   await page.getByRole('button',{name:'7 дней',exact:true}).click();await advanceAutoFilter(weekFilter);await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();
   const quarterRange=await presetPeriod(90),quarterFilter=watchAnalytics({source:'youtube',category:'',timezone:'UTC',...quarterRange});
   await page.getByRole('button',{name:'90 дней',exact:true}).click();await advanceAutoFilter(quarterFilter);await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();
   for(const days of [180,365]){
    const range=await presetPeriod(days),filter=watchAnalytics({source:'youtube',category:'',timezone:'UTC',...range});
    await page.getByRole('button',{name:`${days} дней`,exact:true}).click();await advanceAutoFilter(filter);await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();
   }
   const allRange=await presetPeriod('all'),allFilter=watchAnalytics({source:'youtube',category:'',timezone:'UTC',...allRange});
   await page.getByRole('button',{name:'Все время',exact:true}).click();await advanceAutoFilter(allFilter);await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();
   const emptyRange=await currentPeriod([['from','2000-01-01T00:00'],['to','2000-01-02T00:00']]);
   const emptyFilter=watchAnalytics({source:'youtube',category:'',timezone:'UTC',...emptyRange});
   await page.getByLabel('Начало периода').fill('2000-01-01T00:00');await page.getByLabel('Конец периода').fill('2000-01-02T00:00');await advanceAutoFilter(emptyFilter);await page.getByText('Пока нет точек для графика',{exact:true}).waitFor();
   const invalidRange=await currentPeriod([['from','2000-01-01T00:00'],['to','2002-01-01T00:00']]);
   const invalidFilter=watchAnalytics({source:'youtube',category:'',timezone:'UTC',...invalidRange},400);
   await page.getByLabel('Начало периода').fill('2000-01-01T00:00');await page.getByLabel('Конец периода').fill('2002-01-01T00:00');await advanceAutoFilter(invalidFilter);await page.getByRole('alert').filter({hasText:'INVALID_ANALYTICS_FILTER'}).waitFor();
   const monthRange=await presetPeriod(30),presetFilter=watchAnalytics({source:'youtube',category:'',timezone:'UTC',...monthRange});
   await page.getByRole('button',{name:'30 дней',exact:true}).click();await advanceAutoFilter(presetFilter);await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();
   await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await page.setViewportSize({width:1280,height:800});
   await page.getByRole('button',{name:'Демо',exact:true}).click();await page.clock.fastForward(300);await page.getByRole('cell',{name:'Демо-игра',exact:true}).waitFor();
   const realFilter=watchAnalytics({source:'all',category:'',timezone:'UTC'});
   await page.getByRole('button',{name:'Реальные',exact:true}).click();await advanceAutoFilter(realFilter);await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();
   await page.evaluate(()=>{Storage.prototype.getItem=()=>{throw new Error('storage unavailable');};Storage.prototype.setItem=()=>{throw new Error('storage unavailable');};});
   await page.getByRole('button',{name:'Обзор',exact:true}).click();await openAnalytics({source:'all',category:'',timezone:'Europe/Moscow'});await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).waitFor();
   assert.deepEqual(errors,[]);await saveCoverage(page);await context.close();
  }
 }finally{await browser.close();await h.app.close();await rm(dir,{recursive:true,force:true});}
});
