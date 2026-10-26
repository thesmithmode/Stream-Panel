import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {createHostedApplication} from '../../dist/apps/daemon/src/hosted.js';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {navigate,refreshData} from '../helpers/navigation.mjs';

test('cached screens and profiles render before delayed revalidation without forcing unchanged reports',{timeout:90000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-instant-'));
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const origin=`http://127.0.0.1:${port}`,host=await createHostedApplication(dir,origin,false);
 let browser,release;
 try{
  await host.accounts.createUser('ruslan','ruslan','Руслан','instant-navigation-password');
  const ids={};
  for(const [profile,online] of [['ruslan',5],['gulnaz',9]]){
   const db=host.runtimes.get(profile).db,at=Date.now()-3600000;
   ids[profile]=await db.call('startSession','owner','instant-'+profile,at,'platform',at);
   await db.call('streamSample',ids[profile],at,'game','Game','Private '+profile,online);
   await db.call('endSession',ids[profile],at+60000);
  }
  await host.app.listen({host:'127.0.0.1',port});browser=await launchBrowser();
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(10000);
  const errors=[],reads=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(new URL(r.url()).pathname==='/api/v1/analytics')reads.push(r.url());});
  await goto(page,origin);await page.getByLabel('Логин',{exact:true}).fill('ruslan');await page.getByLabel('Пароль',{exact:true}).fill('instant-navigation-password');await page.getByRole('button',{name:'Войти',exact:true}).click();
  const ready=()=>page.getByLabel('Профиль',{exact:true}).isEnabled();
  for(const profile of ['ruslan','gulnaz']){
   if(profile!=='ruslan')await page.getByLabel('Профиль',{exact:true}).selectOption(profile);
   await page.locator('.channel-metrics').waitFor();await page.waitForFunction(()=>!document.querySelector('.heading-profile select').disabled);
   await navigate(page,'Стримы');await page.locator(`[data-session-id="${ids[profile]}"] .stream-open`).click();await page.locator('.trend-plot svg').waitFor();await page.waitForFunction(()=>!document.querySelector('.heading-profile select').disabled);
   await navigate(page,'Аналитика');await page.locator('.growth-plot').waitFor();await page.waitForFunction(()=>document.querySelector('.analytics-results')?.getAttribute('aria-busy')==='false');
   await navigate(page,'Обзор');await page.locator('.channel-metrics').waitFor();await page.waitForFunction(()=>!document.querySelector('.heading-profile select').disabled);
  }
  let gate=null;const timings=[];
  await page.route('**/api/v1/changes?*',async route=>{if(gate)await gate;await route.continue();});
  async function held(action,selector){
   gate=new Promise(resolve=>{release=resolve;});
   const requested=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/v1/changes');
   const start=performance.now();
   await action();await requested;
   await page.locator(selector).waitFor({timeout:1500});
   timings.push(Math.round(performance.now()-start));
   assert.ok(!(await page.locator('main').textContent()).includes('Загружаем данные'),'cached content must render while changes is still blocked');
   const checked=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/changes');
   release();gate=null;await checked;await page.waitForFunction(()=>!document.querySelector('.heading-profile select').disabled);
  }
  for(const width of [1280,390]){
   await page.setViewportSize({width,height:900});
   for(const profile of ['ruslan','gulnaz']){
    await held(()=>page.getByLabel('Профиль',{exact:true}).selectOption(profile),'.channel-records');
    assert.equal(await page.getByText('Пик зрителей',{exact:true}).locator('..').locator('strong').textContent(),profile==='ruslan'?'5':'9');
    const before=reads.length;
    await held(()=>navigate(page,'Стримы'),`[data-session-id="${ids[profile]}"]`);
    await held(()=>page.locator(`[data-session-id="${ids[profile]}"] .stream-open`).click(),'.trend-plot svg');
    await held(()=>navigate(page,'Аналитика'),'.growth-plot');
    await page.waitForFunction(()=>document.querySelector('.analytics-results')?.getAttribute('aria-busy')==='false');
    assert.equal(reads.length,before,'ordinary navigation must reuse unchanged stream and analytics reports');
    await held(()=>navigate(page,'Обзор'),'.channel-records');
   }
  }
  assert.equal(await ready(),true);await refreshData(page);await page.locator('.channel-records').waitFor();
  assert.deepEqual(errors,[]);console.log(JSON.stringify({cachedNavigationMaxMs:Math.max(...timings),cachedNavigationCount:timings.length}));await page.screenshot({path:'/tmp/instant-navigation-390.png'});await saveCoverage(page);
 }finally{release?.();await browser?.close();await host.app.close();await rm(dir,{recursive:true,force:true});}
});
