import {setFilter} from '../helpers/navigation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
test('insights use complete historical audience beyond the first page; period, category, source, evidence and mobile controls work',{timeout:90000},async()=>{
 const a=await application();let browser;
 try{
  const minute=60000,day=86400000,people=Array.from({length:45},(_,i)=>`Quiet ${i}`);
  for(let n=0;n<5;n++){
   const at=Math.floor((Date.now()-14*day+n*day)/minute)*minute,id=await a.db.call('startSession','owner',`insight-${n}`,at,'platform',at);
   await a.db.call('streamSample',id,at,n===4?'wow':'dota',n===4?'WoW':'Dota','История для инсайтов',10);
   await a.db.call('recordPoll',id,'owner',{startedAtMs:at,completedAtMs:at+59*minute,status:'complete',userIds:people,userNames:Object.fromEntries(people.map(p=>[p,p]))});
   await a.db.call('endSession',id,at+60*minute);
  }
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1280,height:850}}),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await goto(page,a.bootstrap());await page.getByRole('button',{name:'Аналитика',exact:true}).click();
  const section=page.getByRole('region',{name:'Инсайты',exact:true});await section.getByRole('button',{name:'Инсайты'}).click();
  await section.locator('.insight-card').first().waitFor();assert.equal(await section.locator('.insight-card').count(),1);await section.getByText('Молчаливое ядро · 45 участников',{exact:true}).waitFor();assert.equal(await section.locator('.person-finding').count(),3);assert.equal(await section.locator('.grouped').count(),0);assert.equal(await section.locator('details .person-finding').count(),0);assert.ok(await section.locator('.person-finding>summary').first().evaluate(el=>el.getBoundingClientRect().height<=48));
  await section.getByRole('button',{name:/Ещё участники/}).click();assert.equal(await section.locator('.person-finding').count(),6);
  await section.locator('.person-finding>summary').first().click();await section.locator('.evidence>summary').first().click();await section.getByText('Полные опросы Twitch',{exact:false}).first().waitFor();
  assert.equal(await section.locator('.insight-filters').count(),0);assert.ok(await section.locator('.insight-card').count()>0);
  const screenshots=process.env.STREAM_PANEL_BROWSER_COVERAGE_DIR;
  if(screenshots){await mkdir(screenshots,{recursive:true});await section.screenshot({path:join(screenshots,'insights-desktop.png')});}
  await setFilter(page,'Период аналитики','7');await section.getByText('Для выбранного периода пока недостаточно данных для выводов.',{exact:false}).waitFor();
  await setFilter(page,'Период аналитики','30');await section.locator('.insight-card').first().waitFor();
  await setFilter(page,'Категория Twitch','wow');await section.getByText('Для выбранного периода пока недостаточно данных для выводов.',{exact:false}).waitFor();
  await setFilter(page,'Категория Twitch','dota');await section.locator('.insight-card').first().waitFor();
  await setFilter(page,'Площадка','youtube');await section.getByText('Для выбранного периода пока недостаточно данных для выводов.',{exact:false}).waitFor();
  await setFilter(page,'Площадка','all');await section.locator('.insight-card').first().waitFor();
  await page.setViewportSize({width:390,height:844});await section.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(screenshots)await page.screenshot({path:join(screenshots,'insights-mobile.png')});
  await section.locator('.person-finding>summary').first().click();await section.getByRole('button',{name:'Открыть человека'}).first().click();await page.getByRole('heading',{name:/Quiet/}).waitFor();assert.deepEqual(errors,[]);
  await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
