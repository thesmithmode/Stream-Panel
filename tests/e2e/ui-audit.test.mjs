import test from 'node:test';
import assert from 'node:assert/strict';
import {application,seed} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {navigate} from '../helpers/navigation.mjs';
import {assertUiLayout} from '../helpers/ui-layout.mjs';

test('audio donations keep their link and amount across donations, stream events and person history',{timeout:60000},async()=>{
 const a=await application();let browser;
 try{
  const id=await seed(a),at=Date.now()-60000,url='https://example.test/voice.wav';
  await a.db.call('ingest',{source:'donationalerts',accountId:'test-recipient',externalId:'voice',type:'donation',actor:{externalId:'name:тестовый зритель',displayName:'Тестовый зритель'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'rest',payload:{text:url,amountMinor:'12345',currency:'RUB'}});
  await a.db.call('ingest',{source:'twitch',accountId:'test-channel',externalId:'voice-no-url',type:'chat.message',actor:{externalId:'42',displayName:'Тестовый зритель'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'Без ссылки',messageType:'audio'}});
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  await goto(page,a.bootstrap());
  await navigate(page,'Донаты');
  const donation=page.locator('.donation-list article').filter({has:page.getByRole('link',{name:'Слушать',exact:true})});
  await donation.getByText('123,45 RUB',{exact:true}).waitFor();
  const listen=donation.getByRole('link',{name:'Слушать',exact:true});
  assert.equal(await listen.getAttribute('href'),url);assert.equal(await listen.getAttribute('target'),'_blank');assert.match(await listen.getAttribute('rel'),/noopener/);
  assert.equal(await page.getByText(url,{exact:true}).count(),0);await assertUiLayout(page);
  await navigate(page,'Стримы');await page.locator(`[data-session-id="${id}"] .stream-open`).click();
  await page.getByRole('tab',{name:'События',exact:true}).click();await page.locator('.recent-events').getByRole('link',{name:'Слушать',exact:true}).waitFor();
  await page.locator('.recent-events').getByText('Голосовое сообщение',{exact:true}).first().waitFor();
  assert.equal(await page.getByText(url,{exact:true}).count(),0);await assertUiLayout(page);
  await navigate(page,'Люди');await page.locator('.person-row').filter({hasText:'Тестовый зритель'}).first().click();
  await page.getByRole('tab',{name:'Донаты',exact:true}).click();
  await page.locator('.person-detail').getByRole('link',{name:'Слушать',exact:true}).waitFor();
  assert.equal(await page.getByText(url,{exact:true}).count(),0);assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
