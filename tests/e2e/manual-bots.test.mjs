import test from 'node:test';
import assert from 'node:assert/strict';
import {application,seed} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,startCoverage,saveCoverage,reload} from '../helpers/browser-coverage.mjs';
import {navigate} from '../helpers/navigation.mjs';
import {assertUiLayout} from '../helpers/ui-layout.mjs';

test('manual bot marks, filters, cached statistics and independent highlight preferences work on desktop and mobile',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  await seed(app);browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await startCoverage(page);await goto(page,app.bootstrap());
  const classify=async(label,value)=>{const target=value?label:'Неизвестно';const saved=page.waitForResponse(r=>r.url().endsWith('/classification')&&r.request().method()==='POST'&&r.status()===200);await page.getByRole('radio',{name:target,exact:true}).click();await saved;await page.waitForFunction(target=>{const button=document.querySelector(`.classification button[aria-label="${target}"]`);return button&&!button.disabled&&button.getAttribute('aria-checked')==='true';},target);};
  const setBots=async value=>{await navigate(page,'Настройки');await page.getByLabel('Отображать ботов',{exact:true}).setChecked(value);await page.getByRole('button',{name:'Сохранить настройки',exact:true}).click();await page.waitForFunction(async value=>(await(await fetch('/api/v1/settings')).json()).includeBots===value,value);};
  const open=async()=>{await navigate(page,'Люди');await page.locator('.person-row').filter({hasText:'Тестовый зритель'}).click();};
  await open();assert.equal(await page.locator('.classification-control.locked').count(),0);assert.match(await page.locator('.classification').evaluate(e=>getComputedStyle(e).backgroundImage),/linear-gradient.*40, 126, 172.*155, 61, 73/);await page.locator('.classification-control').screenshot({path:'/tmp/sp-switch-enabled.png'});await classify('Бот',true);
  assert.equal(await page.locator('.person-detail.bot-person,.person-detail.human-person').count(),0);
  const person=(await app.db.call('persons')).find(p=>p.display_name==='Тестовый зритель');
  assert.equal((await app.db.call('personBot',person.id)).manualBot,true);
  await page.getByRole('tab',{name:'Сообщения',exact:true}).click();await page.locator('article.bot-person').first().waitFor();
  const botColor=await page.locator('article.bot-person').first().evaluate(e=>getComputedStyle(e).backgroundColor);assert.notEqual(botColor,'rgba(0, 0, 0, 0)');
  await navigate(page,'Люди');
  await setBots(true);await navigate(page,'Люди');await page.locator('.person-row.bot-person').waitFor();assert.equal(await page.getByLabel('Фильтр ботов').count(),0);await page.locator('.person-row.human-person').waitFor();await setBots(false);await navigate(page,'Люди');await page.locator('.person-row').filter({hasText:'Тестовый зритель'}).waitFor({state:'hidden'});
  // The setting is global to statistics and survives navigation/reload.
  const request=async path=>page.evaluate(async p=>{const r=await fetch('/api/v1/'+p);return {status:r.status,value:await r.json()};},path);
  const clean=await request('summary');assert.equal(clean.value.messages,4);
  await setBots(true);
  await page.waitForFunction(async()=>{const r=await fetch('/api/v1/settings');return (await r.json()).includeBots===true;});
  assert.equal((await request('summary')).value.messages,8);
  assert.equal((await request('summary?includeBots=0')).value.messages,4);
  assert.equal((await request('summary?includeBots=no')).status,400);
  await navigate(page,'Настройки');await page.getByLabel('Выделять ботов голубым').uncheck();await page.getByLabel('Выделять людей красным').uncheck();
  await page.getByRole('button',{name:'Сохранить настройки',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.app-shell.highlight-bots')&&!document.querySelector('.app-shell.highlight-humans'));
  await open();await page.getByRole('tab',{name:'Сообщения',exact:true}).click();await page.locator('article.bot-person').first().waitFor();
  assert.notEqual(await page.locator('article.bot-person').first().evaluate(e=>getComputedStyle(e).backgroundColor),botColor);
  await reload(page);await page.waitForFunction(()=>document.querySelector('.app-shell')&&!document.querySelector('.app-shell.highlight-bots'));assert.equal(await page.locator('.app-shell.highlight-bots').count(),0);
  await page.setViewportSize({width:390,height:844});await navigate(page,'Настройки');await page.getByLabel('Выделять ботов голубым').check();await page.getByLabel('Выделять людей красным').check();
  await page.getByRole('button',{name:'Сохранить настройки',exact:true}).click();await page.locator('.app-shell.highlight-bots.highlight-humans').waitFor();
  await assertUiLayout(page);await page.screenshot({path:'/tmp/sp-bots-mobile.png',fullPage:true});
  await open();await classify('Человек',true);await page.getByRole('radio',{name:'Бот',exact:true}).waitFor();assert.equal(await page.getByRole('radio',{name:'Бот',exact:true}).getAttribute('aria-checked'),'false');
  await classify('Человек',false);await classify('Бот',true);await classify('Бот',false);
  const move=async(key,label)=>{const saved=page.waitForResponse(r=>r.url().endsWith('/classification')&&r.request().method()==='POST'&&r.status()===200);await page.getByRole('radio',{name:await page.locator('.classification [aria-checked="true"]').getAttribute('aria-label'),exact:true}).press(key);await saved;await page.waitForFunction(label=>{const button=document.querySelector(`.classification button[aria-label="${label}"]`);return button&&!button.disabled&&button.getAttribute('aria-checked')==='true';},label);};
  await move('ArrowRight','Человек');await move('Home','Бот');await move('End','Человек');await move('ArrowLeft','Неизвестно');
  // Donated money makes a Twitch card ineligible at the API as well as in the UI.
  await app.db.call('createDonation',{personId:person.id,amount:'1',currency:'RUB',occurredAtMs:Date.now(),message:'',sourceName:'Manual'},Date.now());
  await reload(page);await page.getByRole('radio',{name:'Человек',exact:true}).waitFor();assert.equal(await page.getByRole('radio',{name:'Человек',exact:true}).getAttribute('aria-checked'),'true');assert.equal(await page.getByRole('radio',{name:'Человек',exact:true}).isDisabled(),true);assert.equal(await page.locator('.person-detail.bot-person,.person-detail.human-person').count(),0);assert.equal(await page.getByRole('radio',{name:'Бот',exact:true}).isDisabled(),true);
  await page.locator('.classification-control.locked').waitFor();assert.equal(await page.getByRole('img',{name:/Статус «Человек» закреплён/}).count(),1);assert.equal(await page.locator('.classification-control').evaluate(e=>getComputedStyle(e).filter),'grayscale(1)');await page.locator('.classification-control').screenshot({path:'/tmp/sp-switch-locked.png'});await assertUiLayout(page);
  const bot=await app.db.call('personBot',person.id),status=await request('status');
  const denied=await page.evaluate(async({id,revision,csrf})=>(await fetch(`/api/v1/persons/${id}/bot`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({bot:true,revision})})).status,{id:person.id,revision:bot.revision,csrf:status.value.csrf});
  assert.equal(denied,400);
  await page.setViewportSize({width:1440,height:1000});await assertUiLayout(page);await page.screenshot({path:'/tmp/sp-bots-desktop.png',fullPage:true});
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
