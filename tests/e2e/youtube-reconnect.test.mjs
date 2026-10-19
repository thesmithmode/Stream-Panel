import test from 'node:test';
import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {startCoverage,saveCoverage,goto,reload} from '../helpers/browser-coverage.mjs';

test('YouTube reconnect reuses saved credentials without disconnecting on desktop and mobile', {timeout:45000}, async()=>{
  const a=await application();const browser=await launchBrowser();
  try{
    a.configuration.value.youtubeClientId='saved-client';a.configuration.value.youtubeClientSecret='saved-secret';
    const original={access:'access',refresh:'refresh',userId:'channel',scopes:[],expiresAt:Date.now()+3600000};
    a.configuration.value.youtube=original;await a.configuration.save();
    for(const viewport of [{width:1280,height:900},{width:390,height:844}]){
      a.youtube.status={state:'error',account:'channel',detail:'YOUTUBE_REFRESH_REJECTED'};
      const context=await browser.newContext({viewport});const page=await context.newPage();page.setDefaultTimeout(8000);
      const errors=[];page.on('pageerror',error=>errors.push(error.message));await startCoverage(page);
      await context.route('https://accounts.google.com/**',route=>route.fulfill({contentType:'text/html',body:'Google fixture'}));
      await goto(page,a.bootstrap());
      await page.getByRole('navigation').getByRole('button',{name:'Интеграции',exact:true}).click();
      const panel=page.locator('section.settings:not(.wide)').filter({has:page.getByRole('heading',{name:'YouTube',exact:true})});
      await panel.getByText(/Google отклонил токен продления/).waitFor();
      assert.equal(await panel.locator('input[type=password]:visible').count(),0);
      const popupPromise=page.waitForEvent('popup');
      await panel.getByRole('button',{name:'Повторить вход в Google',exact:true}).click();
      const popup=await popupPromise;await popup.waitForURL('https://accounts.google.com/**');
      assert.equal(new URL(popup.url()).searchParams.get('client_id'),'saved-client');await popup.close();
      assert.equal(a.configuration.value.youtube,original);assert.equal(a.configuration.value.youtubeClientSecret,'saved-secret');
      a.youtube.status={state:'disconnected',account:'',detail:''};await reload(page);
      await panel.getByText('Client secret сохранён. Повторный ввод не требуется.',{exact:true}).waitFor();
      assert.equal(await panel.locator('input[type=password]:visible').count(),0);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
      assert.deepEqual(errors,[]);await saveCoverage(page);await context.close();
    }
  }finally{await browser.close();await a.close();}
});
