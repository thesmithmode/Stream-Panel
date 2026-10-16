import {clockActivitySeries} from '../../dist/packages/core/src/clock-activity.js';
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
  await db.call('youtubeSnapshot','yt-owner','report',{start:'2026-10-01',end:'2026-10-06',columnHeaders:[{name:'day'},{name:'views'},{name:'estimatedMinutesWatched'},{name:'subscribersGained'},{name:'subscribersLost'},{name:'unknownMetric'}],rows:[['2026-10-06',7,123,2,1,9],['2026-10-05',0,0,0,0,0]]},Date.now());
  runtime.configuration.value.youtube={userId:'yt-owner',access:'fixture',refresh:'fixture',expiresAt:Date.now()+3600000,scopes:[]};
  for(let n=0;n<3;n++){
   const base=Math.floor((Date.now()-(4-n)*86400000)/86400000)*86400000+10*3600000,sid=await db.call('startSession','channel',`stream-${n}`,base,'platform',base);
   await db.call('streamSample',sid,base,'game','Game A','Game A title',12);await db.call('streamSample',sid,base+10*minute,'talk','Just Chatting','Talk title',15);await db.call('youtubeViewers',base,4);
   for(const [actor,name] of [['regular',`Regular ${profile}`],...(n===0?[['casual',`Occasional ${profile}`]]:[]),['owner','RenamedOwner'],['bot','jeetbot'],['self','streamlabs'],['typo','streemelements'],['creatis','CreatisBot'],['night','Nightbot'],['franky','franky_showman']])await db.call('ingest',{source:'twitch',accountId:'channel',externalId:`${n}-${actor}`,type:'chat.message',actor:{externalId:actor,displayName:name},occurredAtMs:base+minute,receivedAtMs:base+minute,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}});
   await db.call('ingest',{source:'donationalerts',accountId:'da',externalId:`tip-${n}`,type:'donation',actor:{externalId:`name:regular ${profile}`,displayName:`Regular ${profile}`},occurredAtMs:base+minute,receivedAtMs:base+minute,sourceTime:null,timeQuality:'configured',transport:'rest',payload:{amountMinor:'100',currency:'RUB'}});
   await db.call('recordPoll',sid,'channel',{startedAtMs:base,completedAtMs:base+9*minute,status:'complete',userIds:['regular','owner','bot','self','typo','creatis','night','franky',...(n===0?['casual']:[])]});
   await db.call('recordPoll',sid,'channel',{startedAtMs:base+12*minute,completedAtMs:base+15*minute,status:'complete',userIds:['regular']});
   await db.call('observePlatformStream','youtube','yt-owner',`video-${n}`,base,base,null,'YouTube stream');
   await db.call('youtubeMessages','yt-owner',`chat-${n}`,[{id:`yt-${n}`,snippet:{type:'textMessageEvent',publishedAt:new Date(base+minute).toISOString(),displayMessage:'hello'},authorDetails:{channelId:'yt-regular',displayName:`YT ${profile}`}}]);
   await db.call('endSession',sid,base+20*minute,'observed');
  }
 }
 for(const profile of ['ruslan','gulnaz'])await h.runtimes.get(profile).db.call('followingSnapshot','youtube','yt-owner',[{id:'yt-regular',name:`YT ${profile}`,followedAtMs:null}],true,Date.now(),1);
 const browser=await launchBrowser();
 try{
  for(const profile of ['ruslan','gulnaz']){
   const context=await browser.newContext();const page=await context.newPage();await page.clock.install();page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
   const watchAnalytics=(query,status=200,extra=()=>true)=>page.waitForResponse(response=>{
    const url=new URL(response.url());
    return url.pathname==='/api/v1/analytics'&&response.status()===status&&Object.entries(query).every(([key,value])=>url.searchParams.get(key)===String(value))&&extra(url);
   });
   const advanceAutoFilter=async(response)=>{await page.clock.fastForward(300);return response;};
   const openAnalytics=async(query)=>{const response=watchAnalytics(query);await page.getByRole('button',{name:'Аналитика',exact:true}).click();const result=await advanceAutoFilter(response);return result;};
   const currentPeriod=async(values)=>page.evaluate(inputs=>Object.fromEntries(inputs.map(([key,value])=>[key,String(new Date(value).getTime())])),values);
   const presetPeriod=async(days)=>page.evaluate(span=>{
    const localInput=at=>{const d=new Date(at);return new Date(at-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
    return {from:String(new Date(localInput(span==='all'?0:Date.now()-span*86400000)).getTime()),to:String(new Date(localInput(Date.now())).getTime())};
   },days);
   await goto(page,origin);await page.getByLabel('Логин',{exact:true}).fill(profile);await page.getByLabel('Пароль',{exact:true}).fill(`${profile}-analytics-password`);await page.getByRole('button',{name:'Войти',exact:true}).click();
   const analyticsResponse=await openAnalytics({source:'all',category:'',timezone:'Europe/Moscow'});let analyticsData=await analyticsResponse.json();await page.getByRole('heading',{name:'Агрегатный отчёт YouTube: все видео канала',exact:true}).waitFor();await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).waitFor();
   const report=page.getByRole('heading',{name:'Агрегатный отчёт YouTube: все видео канала',exact:true}).locator('..').locator('..');
   for(const label of ['Дата','Просмотры','Минуты просмотра','Новые подписчики','Отписки','unknownMetric'])assert.equal(await report.getByRole('columnheader',{name:label,exact:true}).count(),1);
   assert.equal(await report.getByRole('cell',{name:'2026-10-05',exact:true}).count(),1);
   const comparison=page.getByRole('heading',{name:'Сравнение стримов',exact:true}).locator('..').locator('..');
   assert.equal(await comparison.getByRole('cell',{name:'13.5 / 15',exact:true}).count(),3);
   assert.equal(await comparison.getByRole('cell',{name:'4.0 / 4',exact:true}).count(),3);
   assert.equal(await comparison.getByRole('columnheader',{name:'Чатеры: уник. / пик / ср.',exact:true}).count(),1);
   assert.equal(await page.getByRole('button',{name:'Применить',exact:true}).count(),0);
   for(const label of ['Порог постоянника, % посещений','Минимум эфиров','Минимум минут активности','Минимум сообщений','Правило ядра','Окно активности YouTube, мин'])assert.equal(await page.getByLabel(label,{exact:true}).count(),0,label);
   assert.equal(await page.getByText('Как определять ядро аудитории',{exact:true}).count(),0);
   for(const name of ['RenamedOwner','jeetbot','streamlabs','streemelements','CreatisBot','Nightbot','franky_showman',`Regular ${profile==='ruslan'?'gulnaz':'ruslan'}`])assert.equal(await page.getByRole('button',{name,exact:true}).count(),0);
   const activity=page.locator('.activity-clock');
   await activity.getByText('00:00',{exact:true}).waitFor();await activity.getByText('24:00',{exact:true}).waitFor();
   for(const [step,count] of [['1',1440],['15',96],['30',48],['60',24]]){
    await activity.getByLabel('Шаг графика').selectOption(step);assert.equal(await activity.getByRole('button').filter({hasNot:page.locator('header')}).count()>0,true);
    assert.equal(await activity.locator('svg g').count(),count);
   }
   for(const metric of ['viewers','twitchViewers','youtubeViewers','messages','twitchMessages','youtubeMessages']){
    await activity.getByLabel('Метрика графика').selectOption(metric);
    const expected=clockActivitySeries(analyticsData.activityClock,metric,60);
    const labels=await activity.locator('svg g').evaluateAll(groups=>groups.map(g=>g.getAttribute('aria-label')));
    expected.forEach((b,i)=>assert.ok(labels[i].includes(b.value===null?'нет данных':b.value.toLocaleString('ru-RU',{maximumFractionDigits:2}))));
   }
   await activity.locator('svg g').first().focus();await page.keyboard.press('Enter');assert.ok((await activity.getByRole('status').textContent()).includes('00:00–01:00'));
   for(const group of ['weekdays','weekends','all']){await activity.getByLabel('Дни недели').selectOption(group);assert.equal(await activity.locator('svg g').count(),24);}
   await activity.getByLabel('Шаг графика').selectOption('1');
   await page.getByText('Настроить отображение',{exact:true}).click();
   await page.getByLabel('Только ядро').check();assert.equal(await page.getByRole('button',{name:`Occasional ${profile}`,exact:true}).count(),0);
   await page.getByLabel('Сортировка').selectOption('attendanceRatio');
   await page.getByLabel('Вид дней и часов').selectOption('table');assert.equal(await page.locator('.hour-heatmap').count(),0);
   const hourSection=page.locator('.hour-table');await hourSection.locator('summary').click();
   const firstHour=analyticsData.hours[0],metricValue=(cell,metric)=>metric==='viewers'?(cell.viewerSamples?cell.viewersTotal/cell.viewerSamples:null):metric==='messages'?(cell.sampleMinutes?cell.messages*60/cell.sampleMinutes:null):metric==='estimated'?(cell.sampleMinutes?cell.estimated/cell.sampleMinutes:null):(cell.observedKnownMinutes?cell.observed/cell.observedKnownMinutes:null);
   for(const metric of ['observed','estimated','messages','viewers']){await page.getByLabel('Метрика карты').selectOption(metric);const displayed=(await hourSection.locator('.analytics-table tbody tr').first().locator('td').nth(1).textContent()).trim(),value=metricValue(firstHour,metric);assert.equal(displayed,value===null?'нет данных':value.toFixed(1),`hour table should render ${metric} from API data`);}
   await page.getByLabel('Вид дней и часов').selectOption('map');assert.equal(await page.locator('.hour-heatmap').count(),1);
   for(const metric of ['observed','estimated','messages','viewers']){await page.getByLabel('Метрика карты').selectOption(metric);assert.ok(await page.locator('.hour-heatmap').count()>0);}
   const sections=[['Отчёт YouTube','Агрегатный отчёт YouTube: все видео канала'],['График активности','Активность по времени суток'],['Сравнение категорий','Категории'],['Дни и часы','Активность по дням и часам'],['Сравнение стримов','Сравнение стримов'],['Возвращаемость участников','Возвращаемость участников']];
   for(const [label,heading] of sections){await page.getByLabel(label,{exact:true}).uncheck();assert.equal(await page.getByRole('heading',{name:heading,exact:true}).count(),0);await page.getByLabel(label,{exact:true}).check();}
   await page.getByLabel('График активности',{exact:true}).uncheck();
   await page.getByRole('button',{name:'Обзор',exact:true}).click();await openAnalytics({source:'all',category:'',timezone:'Europe/Moscow'});await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).waitFor();
   assert.equal(await page.getByRole('heading',{name:'Активность по времени суток',exact:true}).count(),0);
   await page.getByText('Настроить отображение',{exact:true}).click();
   await page.getByLabel('График активности',{exact:true}).check();
   assert.equal(await page.getByLabel('Шаг графика').inputValue(),'1');assert.equal(await page.getByLabel('Только ядро').isChecked(),true);
   await page.getByRole('button',{name:'Сбросить отображение',exact:true}).click();await page.getByRole('heading',{name:'Активность по времени суток',exact:true}).waitFor();
   assert.equal(await page.getByLabel('Только постоянники').count(),0);await page.getByLabel('Метрика графика').selectOption('messages');assert.equal(await page.locator('.activity-clock svg g').count(),96);
   if(profile==='ruslan'){
    for(const width of [320,390,768,1280,1440]){
     await page.setViewportSize({width,height:900});
     for(const tab of ['Обзор','Стримы','Люди','Аналитика','Интеграции']){
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
      await page.setViewportSize({width:1280,height:800});analyticsData=await (await openAnalytics({source:'all',category:'',timezone:'Europe/Moscow'})).json();await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).waitFor();
   }
   await page.getByLabel('Только ядро').check();
   const defaultCoreCount=parseInt(await page.locator('.regular-summary strong').textContent(),10);
   const audienceSection=page.getByRole('heading',{name:'Возвращаемость участников',exact:true}).locator('..').locator('..');
   const visibleCoreRows=await audienceSection.locator('.compact-audience-table tbody tr').count();
   assert.equal(visibleCoreRows,defaultCoreCount,'core-only filter must use default-qualified audience');
   assert.equal(await audienceSection.locator('.compact-audience-table tbody tr').evaluateAll(rows=>rows.every(row=>row.querySelector('.core-badge'))),true);
   await page.getByLabel('Только ядро').uncheck();
   for(const sort of ['observedMinutes','estimatedChatMinutes','sessions','messages','attendanceRatio']){await page.getByLabel('Сортировка').selectOption(sort);const names=await audienceSection.locator('.compact-audience-table tbody tr').evaluateAll(rows=>rows.map(row=>row.cells[0].querySelector('button')?.textContent?.trim()??'')),expected=[...analyticsData.audience].sort((a,b)=>sort==='sessions'?b.sessionIds.length-a.sessionIds.length:(b[sort]??0)-(a[sort]??0)).map(entity=>entity.name);assert.deepEqual(names,expected,`${sort} order follows descending API metric`);}
   await page.getByLabel('Поиск участника').fill('Regular');await page.getByRole('button',{name:`Интервалы Regular ${profile}`,exact:true}).click();
   await page.getByRole('heading',{name:`Активность: Regular ${profile}`}).waitFor();assert.equal(await page.locator('.minute-dot').count(),1440);
   for(const state of ['observed','unknown'])assert.ok(await page.locator(`.minute-dot.${state}`).count()>0,`selected regular viewer timeline includes ${state}`);
   assert.ok(await page.getByText(/Эфиров: \d+ · Сообщений: \d+ · Наблюдений: [\d.]+ мин · Оценка активности по чату: [\d.]+ мин/).count());await page.getByRole('button',{name:'Закрыть детализацию'}).click();
   await page.getByLabel('Поиск участника').fill('Occasional');await page.getByRole('button',{name:`Интервалы Occasional ${profile}`,exact:true}).click();assert.ok(await page.locator('.minute-dot.not_observed').count()>0,'attendee absent from a complete poll is explicitly not observed');await page.getByRole('button',{name:'Закрыть детализацию'}).click();
   await page.getByLabel('Поиск участника').fill('');
   for(const metric of ['youtubeMessages','messages','viewers','twitchMessages']){await page.getByLabel('Метрика графика').selectOption(metric);await page.getByLabel('Метрика карты').selectOption(metric.endsWith('Messages')?'messages':metric);assert.ok(await page.locator('.activity-clock svg g').count()>0);}
   assert.equal(await page.getByLabel('Обновлять каждую минуту').count(),0);
   const initialRefresh=page.waitForResponse(r=>r.url().includes('/api/v1/analytics?')&&r.status()===200);
   await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await initialRefresh;
   await page.getByLabel('Интервал автообновления').selectOption('60');
   const previousEnd=await page.getByLabel('Конец периода').inputValue();
   const refreshed=page.waitForResponse(r=>r.url().includes('/api/v1/analytics?')&&r.status()===200);const statusUpdate=page.waitForResponse(r=>r.url().endsWith('/api/v1/status')&&r.status()===200);await page.clock.fastForward(60000);await statusUpdate;await page.waitForFunction(previous=>[...document.querySelectorAll('input[type=\"datetime-local\"]')][1]?.value>previous,previousEnd);await page.clock.fastForward(300);await refreshed;
   assert.ok(await page.getByLabel('Конец периода').inputValue()>previousEnd,'live analytics must include newly recorded minutes');
   await page.getByRole('button',{name:`Интервалы YT ${profile}`,exact:true}).click();await page.getByText('Оценка по чату YouTube',{exact:true}).first().waitFor();assert.ok(await page.locator('.minute-dot.estimated').count()>0);await page.getByRole('button',{name:'Закрыть детализацию'}).click();
   const autoFilter=watchAnalytics({source:'all',category:'game',timezone:'UTC'});
   if(await page.locator('.analytics-thresholds').getAttribute('open')===null)await page.getByText('Настроить отображение',{exact:true}).click();
   await page.getByLabel('Часовой пояс сравнения').selectOption('UTC');await page.getByLabel('Категория Twitch').selectOption('game');await advanceAutoFilter(autoFilter);
   await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).waitFor();
   assert.equal(await page.getByRole('heading',{name:'Агрегатный отчёт YouTube: все видео канала',exact:true}).count(),0);
   const resetCategory=watchAnalytics({source:'all',category:'',timezone:'UTC'});await page.getByRole('button',{name:'Сбросить категорию',exact:true}).click();await advanceAutoFilter(resetCategory);assert.equal(await page.getByLabel('Категория Twitch').inputValue(),'');
   const selectCategory=watchAnalytics({source:'all',category:'game',timezone:'UTC'});await page.getByLabel('Категория Twitch').selectOption('game');await advanceAutoFilter(selectCategory);
   const youtubeFilter=watchAnalytics({source:'youtube',category:'game',timezone:'UTC'});
   await page.getByLabel('Площадка').selectOption('youtube');await advanceAutoFilter(youtubeFilter);
   await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).waitFor({state:'detached'});assert.equal(await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).count(),0);
   const twitchFilter=watchAnalytics({source:'twitch',category:'game',timezone:'UTC'});
   await page.getByLabel('Площадка').selectOption('twitch');await advanceAutoFilter(twitchFilter);
   await page.getByRole('button',{name:`Интервалы Regular ${profile}`,exact:true}).click();await page.getByText('Донаты с подтверждённым временем:',{exact:false}).first().waitFor();await page.getByRole('button',{name:'Открыть карточку человека',exact:true}).click();await openAnalytics({source:'all',category:'',timezone:'UTC'});await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).waitFor();
   await page.getByRole('button',{name:'Обзор',exact:true}).click();await openAnalytics({source:'all',category:'',timezone:'UTC'});await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).waitFor();
   const youtubeAgain=watchAnalytics({source:'youtube',category:'',timezone:'UTC'});
   await page.getByLabel('Площадка').selectOption('youtube');await advanceAutoFilter(youtubeAgain);await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();
   await page.getByLabel('Сортировка').selectOption('estimatedChatMinutes');await page.getByLabel('Сортировка').selectOption('sessions');await page.getByLabel('Сортировка').selectOption('messages');
   const streamFilter=watchAnalytics({source:'youtube',category:'',timezone:'UTC'},200,url=>Number(url.searchParams.get('to'))-Number(url.searchParams.get('from'))===20*minute);
   await page.getByRole('heading',{name:'Сравнение стримов',exact:true}).locator('..').locator('..').getByRole('button').first().click();await advanceAutoFilter(streamFilter);await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();
   const weekRange=await presetPeriod(7),weekFilter=watchAnalytics({source:'youtube',category:'',timezone:'UTC',...weekRange});
   await page.getByLabel('Период аналитики').selectOption('7');await advanceAutoFilter(weekFilter);await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();
   const thirtyRange=await presetPeriod(30),thirtyFilter=watchAnalytics({source:'youtube',category:'',timezone:'UTC',...thirtyRange});
   await page.getByLabel('Период суточного графика').selectOption('30');await advanceAutoFilter(thirtyFilter);await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();
   assert.equal(await page.getByLabel('Период аналитики').inputValue(),'30');
   const allRange=await presetPeriod('all'),allFilter=watchAnalytics({source:'youtube',category:'',timezone:'UTC',...allRange});
   await page.getByLabel('Период аналитики').selectOption('all');await advanceAutoFilter(allFilter);await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();
   const emptyRange=await currentPeriod([['from','2000-01-01T00:00'],['to','2000-01-02T00:00']]);
   const emptyFilter=watchAnalytics({source:'youtube',category:'',timezone:'UTC',...emptyRange});
   await page.getByLabel('Начало периода').fill('2000-01-01T00:00');await page.getByLabel('Конец периода').fill('2000-01-02T00:00');await advanceAutoFilter(emptyFilter);await page.locator('.activity-clock svg g').first().waitFor();assert.ok((await page.locator('.activity-clock svg g').first().getAttribute('aria-label')).includes('нет данных'));
   const multiYearRange=await currentPeriod([['from','2000-01-01T00:00'],['to','2002-01-01T00:00']]);
   const multiYearFilter=watchAnalytics({source:'youtube',category:'',timezone:'UTC',...multiYearRange});
   await page.getByLabel('Начало периода').fill('2000-01-01T00:00');await page.getByLabel('Конец периода').fill('2002-01-01T00:00');await advanceAutoFilter(multiYearFilter);await page.locator('.activity-clock svg g').first().waitFor();assert.ok((await page.locator('.activity-clock svg g').first().getAttribute('aria-label')).includes('нет данных'));
   const invalidRange=await currentPeriod([['from','2002-01-01T00:00'],['to','2000-01-01T00:00']]);
   const invalidFilter=watchAnalytics({source:'youtube',category:'',timezone:'UTC',...invalidRange},400);
   await page.getByLabel('Начало периода').fill('2002-01-01T00:00');await page.getByLabel('Конец периода').fill('2000-01-01T00:00');await advanceAutoFilter(invalidFilter);await page.getByRole('alert').filter({hasText:'INVALID_ANALYTICS_FILTER'}).waitFor();
   const monthRange=await presetPeriod(30),presetFilter=watchAnalytics({source:'youtube',category:'',timezone:'UTC',...monthRange});
   await page.getByLabel('Период аналитики').selectOption('30');await advanceAutoFilter(presetFilter);await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();
   await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await page.setViewportSize({width:1280,height:800});
   assert.equal(await page.getByRole('button',{name:'Демо',exact:true}).count(),0);
   await page.evaluate(()=>{Storage.prototype.getItem=()=>{throw new Error('storage unavailable');};Storage.prototype.setItem=()=>{throw new Error('storage unavailable');};});
   await page.getByRole('button',{name:'Обзор',exact:true}).click();await openAnalytics({source:'all',category:'',timezone:'Europe/Moscow'});await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).waitFor();
   await page.getByRole('button',{name:'О данных отчёта YouTube',exact:true}).click();
   assert.ok((await page.getByRole('dialog',{name:'О данных отчёта YouTube',exact:true}).textContent()).includes('Отчёт охватывает весь канал'));
   await page.keyboard.press('Escape');
   await page.locator('.compact-audience').getByRole('button',{name:`Regular ${profile}`,exact:true}).click();
   await page.getByRole('heading',{name:`Regular ${profile}`,exact:true}).waitFor();
   assert.deepEqual(errors,[]);await saveCoverage(page);await context.close();
  }
 }finally{await browser.close();await h.app.close();await rm(dir,{recursive:true,force:true});}
});
