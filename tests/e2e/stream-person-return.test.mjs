import test from 'node:test';import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';import {launchBrowser} from '../helpers/browser.mjs';
import {goto,reload,saveCoverage} from '../helpers/browser-coverage.mjs';import {navigate} from '../helpers/navigation.mjs';import {acceptConfirmation} from '../helpers/confirmation.mjs';
import {mkdir} from 'node:fs/promises';
test('stream participant messages retain their origin across reload, explicit return and browser history on desktop and phone',{timeout:90000},async()=>{
 const app=await application();let browser;
 try{
  const now=Date.now(),at=now-120000,id=await app.db.call('observePlatformStream','youtube','primary','video',at,at,null,'Origin stream');
  app.configuration.value.youtubeAccountId='primary';
  const msg=(id,author,name)=>({id,snippet:{type:'textMessageEvent',publishedAt:new Date(now-1000).toISOString(),displayMessage:`Message ${name}`},authorDetails:{channelId:author,displayName:name}});
  await app.db.call('youtubeMessages','primary','chat',[msg('main','primary-viewer','Primary viewer')],'video');
  await app.db.call('youtubeSnapshot','secondary','collectionRole','secondary',now);
  await app.db.call('youtubeSnapshot','secondary','broadcasts',[{id:'second',snippet:{liveChatId:'second-chat'}}],now);
  await app.db.call('youtubeMessages','secondary','second-chat',[msg('extra','secondary-viewer','Second viewer')],'second');
  browser=await launchBrowser();
  for(const viewport of [{width:1280,height:900},{width:390,height:844}]){
   const page=await browser.newPage({viewport});page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await goto(page,app.bootstrap());await navigate(page,'Стримы');await page.locator(`[data-session-id="${id}"] .stream-open`).click();
   await page.getByRole('tab',{name:'Участники',exact:true}).click();
   const ranking=page.getByRole('region',{name:'Рейтинг участников'});await ranking.getByRole('button',{name:'Second viewer',exact:true}).waitFor();
   assert.equal(await ranking.getByRole('button',{name:'Second viewer',exact:true}).evaluate(el=>getComputedStyle(el).color),'rgb(217, 68, 68)');
   await ranking.getByRole('button',{name:'Second viewer',exact:true}).click();await page.getByRole('heading',{name:'Second viewer',exact:true}).waitFor();
   await page.getByRole('tab',{name:'Сообщения',exact:true}).click();await page.getByText('Message Second viewer',{exact:true}).waitFor();
   await reload(page);await page.getByText('Message Second viewer',{exact:true}).waitFor();assert.equal(await page.getByRole('tab',{name:'Сообщения',exact:true}).getAttribute('aria-selected'),'true');
   await page.getByRole('button',{name:'Назад к стриму',exact:true}).click();await ranking.getByRole('button',{name:'Second viewer',exact:true}).waitFor();assert.equal(new URL(page.url()).searchParams.get('stream'),id);
   assert.equal(await page.getByRole('tab',{name:'Участники',exact:true}).getAttribute('aria-selected'),'true');
   await ranking.getByRole('button',{name:'Primary viewer',exact:true}).click();await page.getByRole('heading',{name:'Primary viewer',exact:true}).waitFor();await page.getByRole('tab',{name:'Сообщения',exact:true}).click();
   await page.goBack();await ranking.getByRole('button',{name:'Primary viewer',exact:true}).waitFor();assert.equal(new URL(page.url()).searchParams.get('stream'),id);
   await page.getByRole('tab',{name:'Текущие зрители',exact:true}).click();await page.getByRole('region',{name:'Текущие зрители',exact:true}).getByRole('button',{name:'@Second viewer',exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await mkdir('/tmp/stream-panel-qa',{recursive:true});await page.screenshot({path:`/tmp/stream-panel-qa/participants-${viewport.width}.png`,fullPage:false});
   await page.getByRole('tab',{name:'События',exact:true}).click();await page.getByText('Message Second viewer',{exact:true}).waitFor();
   await navigate(page,'Аналитика');await page.getByRole('tab',{name:'Аудитория',exact:true}).click();await reload(page);assert.equal(await page.getByRole('tab',{name:'Аудитория',exact:true}).getAttribute('aria-selected'),'true');
   await navigate(page,'Интеграции');await page.getByRole('heading',{name:'YouTube · второй канал',exact:true}).waitFor();
   await page.getByLabel('Второй YouTube Client ID',{exact:true}).fill('fixture-client');await page.getByLabel('Второй YouTube Client secret',{exact:true}).fill('fixture-secret');
   await page.context().route('https://accounts.google.com/**',route=>route.fulfill({contentType:'text/html',body:'Google fixture'}));
   const popupPromise=page.waitForEvent('popup');await page.getByRole('button',{name:'Подключить второй YouTube',exact:true}).click();const popup=await popupPromise;await popup.waitForURL('https://accounts.google.com/**');await popup.close();
   await page.getByRole('button',{name:'Отключить второй YouTube',exact:true}).click();await acceptConfirmation(page,'Отключить');await page.getByRole('button',{name:'Подключить второй YouTube',exact:true}).waitFor();
   assert.deepEqual(errors,[]);await saveCoverage(page);await page.close();
  }
  await app.db.call('endSession',id,now+1);
  const page=await browser.newPage({viewport:{width:390,height:844}});await goto(page,app.bootstrap());await navigate(page,'Стримы');
  await page.locator(`[data-session-id="${id}"] .stream-actions summary`).click();await page.getByRole('button',{name:'Удалить',exact:true}).click();await acceptConfirmation(page,'Удалить');
  await page.getByText('Стримов пока нет',{exact:true}).waitFor();assert.equal((await app.db.call('sessions')).length,0);assert.equal((await app.db.call('persons')).length,2);await saveCoverage(page);await page.close();
 }finally{await browser?.close();await app.close();}
});
