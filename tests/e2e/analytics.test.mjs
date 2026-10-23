import {refreshData,setRefreshInterval} from '../helpers/navigation.mjs';
import {navigate,setFilter,openFilters,closeFilters,clockSettings} from '../helpers/navigation.mjs';
import {clockActivitySeries,clockDonationSeries} from '../../dist/packages/core/src/clock-activity.js';
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
   const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
   const waitReport=(query={})=>page.waitForResponse(async r=>{const u=new URL(r.url());return u.pathname==='/api/v1/analytics'&&r.request().headers()['x-stream-panel-profile']===profile&&r.status()===200&&Object.entries(query).every(([k,v])=>u.searchParams.get(k)===String(v))&&!(await r.json()).preparing;});
   const selectFilter=async(label,value,query)=>{const response=waitReport(query);await setFilter(page,label,value);await page.waitForFunction(()=>document.querySelector('.analytics-results')?.getAttribute('aria-busy')==='false');await refreshData(page);return (await response).json();};
   await goto(page,origin);await page.getByLabel('Логин',{exact:true}).fill(profile);await page.getByLabel('Пароль',{exact:true}).fill(`${profile}-analytics-password`);await page.getByRole('button',{name:'Войти',exact:true}).click();
   await navigate(page,'Аналитика');await page.locator('.growth-plot').waitFor();await page.waitForFunction(()=>document.querySelector('.analytics-results')?.getAttribute('aria-busy')==='false');const first=waitReport();await page.evaluate(()=>window.dispatchEvent(new Event('sp:data-refresh')));let analyticsData=await (await first).json();
   assert.equal(await page.getByLabel('Начало периода').isVisible(),false);assert.equal(await page.locator('.chart-category select').count(),0,'one category control replaces repeated chart filters');
   assert.equal(await page.locator('.youtube-report').count(),0);
   assert.equal(await page.getByText('Таблица сравнения стримов',{exact:true}).count(),0);assert.equal(await page.getByRole('heading',{name:'YouTube · итоги канала',exact:true}).count(),0);
   await page.locator('summary').filter({hasText:'Возвращаемость по эфирам'}).click();await page.locator('.comparison-charts').waitFor();await page.locator('.category-comparison').waitFor();assert.ok(await page.locator('.category-comparison .category-row').count()>0);await page.getByRole('button',{name:'Участники',exact:true}).click();assert.equal(await page.locator('.category-comparison table').count(),0);for(const width of [320,1280]){await page.setViewportSize({width,height:900});await page.locator('.category-comparison').scrollIntoViewIfNeeded();await assertUiLayout(page);await page.locator('.category-comparison').screenshot({path:`/tmp/categories-${width}.png`});}
   await page.getByRole('tab',{name:'Время',exact:true}).click();await clockSettings(page);const activity=page.locator('.activity-clock');
   await activity.getByText('00:00',{exact:true}).waitFor();await activity.getByText('24:00',{exact:true}).waitFor();
   for(const [step,count] of [['1',1440],['5',288],['15',96],['30',48],['60',24]]){await activity.getByLabel('Шаг графика').selectOption(step);assert.equal(await activity.locator('svg g').count(),count);}
   for(const metric of ['viewers','twitchViewers','youtubeViewers','messages','twitchMessages','youtubeMessages','watchHours','twitchWatchHours','youtubeWatchHours','donations']){
    await activity.getByLabel('Метрика графика').selectOption(metric);const expected=metric==='donations'?clockDonationSeries(analyticsData.activityClock,'RUB',60):clockActivitySeries(analyticsData.activityClock,metric,60,'all',true);const labels=await activity.locator('svg g').evaluateAll(groups=>groups.map(g=>g.getAttribute('aria-label')));expected.forEach((b,i)=>assert.ok(labels[i].includes(b.value===null?'нет данных':b.value.toLocaleString('ru-RU',{maximumFractionDigits:2}))));
   }
   await activity.locator('svg g').first().focus();await page.keyboard.press('Enter');assert.match(await activity.locator('.clock-caption[role=status]').textContent(),/00:00–01:00/);
   for(const day of ['weekdays','weekends','пн','all'])await activity.getByLabel('Дни недели').selectOption(day);
   await page.getByText('Настроить карту',{exact:true}).click();
   const sampled=await page.locator('.heatmap-row button').evaluateAll(cells=>cells.findIndex(c=>/эфиров: [1-9]/.test(c.getAttribute('aria-label')??'')));assert.ok(sampled>=0);await page.locator('.heatmap-row button').nth(sampled).click();
   await page.locator('.hour-table summary').click();const hours=page.locator('.hour-table');
   for(const metric of ['observed','estimated','messages','viewers','donations','amount']){await page.getByLabel('Метрика карты',{exact:true}).selectOption(metric);assert.ok(await hours.locator('tbody tr').count()>0);}
   for(const value of ['total','average'])await page.getByLabel('Расчёт карты',{exact:true}).selectOption(value);
   for(const settings of ['.time-patterns .pattern-controls','.donation-patterns .controls'])await page.locator(`${settings}>summary`).click();
   for(const dimension of ['hour','weekday']){await page.getByLabel('Сравнение времени',{exact:true}).selectOption(dimension);await page.getByLabel('Группировать донаты',{exact:true}).selectOption(dimension);assert.equal(await page.locator('.pattern-row').count(),dimension==='hour'?24:7);}
   for(const metric of ['viewers','messages','observed','estimated','donations','amount'])await page.getByLabel('Показатель времени',{exact:true}).selectOption(metric);
   for(const calculation of ['total','average'])await page.getByLabel('Расчёт времени',{exact:true}).selectOption(calculation);
   for(const metric of ['amount','count'])await page.getByLabel('Показатель донатов',{exact:true}).selectOption(metric);
   await page.getByRole('tab',{name:'Аудитория',exact:true}).click();await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).waitFor();
   const audience=page.locator('.compact-audience-table');for(const name of ['RenamedOwner','jeetbot','streamlabs','streemelements','CreatisBot','Nightbot','franky_showman',`Regular ${profile==='ruslan'?'gulnaz':'ruslan'}`])assert.equal(await audience.getByRole('button',{name,exact:true}).count(),0);
   await page.getByLabel('Только ядро').check();assert.equal(await audience.getByRole('button',{name:`Occasional ${profile}`,exact:true}).count(),0);await page.getByLabel('Только ядро').uncheck();
   for(const sort of ['observedMinutes','estimatedChatMinutes','sessions','messages','attendanceRatio']){await page.getByLabel('Сортировка',{exact:true}).selectOption(sort);const names=await audience.locator('tbody tr').evaluateAll(rows=>rows.map(row=>row.cells[0].querySelector('button')?.textContent?.trim()??''));const expected=[...analyticsData.audience].sort((a,b)=>sort==='sessions'?b.sessionIds.length-a.sessionIds.length:(b[sort]??0)-(a[sort]??0)).map(e=>e.name);assert.deepEqual(names,expected);}
   for(const name of [`Regular ${profile}`,`Occasional ${profile}`,`YT ${profile}`]){await page.getByLabel('Поиск участника').fill(name);await page.getByRole('button',{name:`Интервалы ${name}`,exact:true}).click();await page.locator('.minute-dot').first().waitFor();assert.equal(await page.locator('.minute-dot').count(),1440);await page.getByRole('button',{name:'Закрыть детализацию',exact:true}).click();}
   await page.getByLabel('Поиск участника').fill('');
   await openFilters(page);await page.getByText('Отображение и часовой пояс',{exact:true}).click();
   await page.getByLabel('Вид дней и часов').selectOption('table');for(const label of ['График активности','Сравнение категорий','Дни и часы','Возвращаемость участников']){await page.getByLabel(label,{exact:true}).uncheck();await page.getByLabel(label,{exact:true}).check();}
   await page.getByRole('button',{name:'Сбросить отображение',exact:true}).click();await closeFilters(page);
   analyticsData=await selectFilter('Часовой пояс сравнения','UTC',{timezone:'UTC'});await selectFilter('Категория Twitch','game',{category:'game',timezone:'UTC'});assert.equal(await page.getByRole('heading',{name:'YouTube · итоги канала',exact:true}).count(),0);
   await selectFilter('Площадка','youtube',{source:'youtube',category:'game'});await page.getByRole('button',{name:`YT ${profile}`,exact:true}).waitFor();assert.equal(await audience.getByRole('button',{name:`Regular ${profile}`,exact:true}).count(),0);
   await selectFilter('Площадка','twitch',{source:'twitch',category:'game'});await page.getByRole('button',{name:`Интервалы Regular ${profile}`,exact:true}).click();await page.getByText('Донаты с подтверждённым временем:',{exact:false}).waitFor();await page.getByRole('button',{name:'Закрыть детализацию',exact:true}).click();
   await selectFilter('Площадка','all',{source:'all'});await selectFilter('Категория Twitch','',{category:''});
   for(const days of ['7','30','all'])await selectFilter('Период аналитики',days,{});
   await page.locator('.analytics-toolbar').getByRole('button',{name:'Свои даты',exact:true}).click();const empty=waitReport();await page.getByLabel('Начало периода').fill('2000-01-01T00:00');await page.getByLabel('Конец периода').fill('2000-01-02T00:00');await closeFilters(page);await empty;
   await page.getByText('Нет активности по выбранным фильтрам. Сначала нужны собранные эфиры.',{exact:true}).waitFor();
   await openFilters(page);await page.getByRole('button',{name:'Сбросить фильтры',exact:true}).click();await closeFilters(page);await page.getByRole('button',{name:`Regular ${profile}`,exact:true}).waitFor();
   if(profile==='ruslan')for(const width of [320,390,768,1280,1440]){await page.setViewportSize({width,height:900});for(const name of ['Стримы','Люди','Аналитика','Интеграции']){await navigate(page,name);if(name==='Аналитика')await page.locator('.growth-plot').waitFor();await page.locator('main h1').waitFor();await assertUiLayout(page);}}
   await navigate(page,'Аналитика');await page.locator('.growth-plot').waitFor();assert.equal(await page.locator('.youtube-report').count(),0);
   await page.getByRole('tab',{name:'Аудитория',exact:true}).click();await audience.getByRole('button',{name:`Regular ${profile}`,exact:true}).click();await page.getByRole('heading',{name:`Regular ${profile}`,exact:true}).waitFor();
   assert.deepEqual(errors,[]);await saveCoverage(page);await page.close();
  }
 }finally{await browser.close();await h.app.close();await rm(dir,{recursive:true,force:true});}
});
