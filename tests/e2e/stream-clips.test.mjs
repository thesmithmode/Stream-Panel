import assert from 'node:assert/strict';
import test from 'node:test';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage,startCoverage} from '../helpers/browser-coverage.mjs';
import {navigate,refreshData} from '../helpers/navigation.mjs';

test('the phone can mark a live stream and open its archive from a minute before the mark',{timeout:60000},async()=>{
  const start=Date.now()-120_000;
  const a=await application({twitch:{request:async input=>Response.json({data:
    new URL(String(input)).pathname==='/helix/streams'
      ? [{id:'200',user_id:'42',type:'live',started_at:new Date(start).toISOString()}]
      : [{id:'300',user_id:'42',stream_id:'200',type:'archive'}]
  })}});
  let browser;
  try{
    a.configuration.value.twitch={userId:'42',access:'test',refresh:'test',expiresAt:Date.now()+3600_000,scopes:[]};
    const id=await a.db.call('observePlatformStream','twitch','42','200',start,Date.now(),null,'Clip stream');
    browser=await launchBrowser();
    const page=await browser.newPage({viewport:{width:320,height:700},isMobile:true,hasTouch:true});
    await startCoverage(page);
    await goto(page,a.bootstrap());
    await navigate(page,'Стримы');
    assert.equal(await page.getByRole('button',{name:'Клип',exact:true}).count(),0);
    await page.getByRole('link',{name:'Открыть Clip stream'}).click();
    const button=page.getByRole('button',{name:'Клип',exact:true});
    await button.tap();
    await page.getByText(/^Сохранено · /).waitFor();
    const [clip]=(await a.db.call('streamClips',id,'42')).clips;
    await page.getByRole('tab',{name:'Клипы',exact:true}).click();
    await page.getByText('Запись пока недоступна').waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),320);
    await a.db.call('endSession',id,Date.now());
    await refreshData(page);
    await button.waitFor({state:'detached'});
    const link=page.getByRole('link',{name:/Открыть запись с/});
    await link.waitFor();
    const offset=clip.positionSeconds-60;
    assert.equal(await link.getAttribute('href'),`https://www.twitch.tv/videos/300?t=0h${Math.floor(offset/60)}m${offset%60}s`);
    await saveCoverage(page);
  }finally{await browser?.close();await a.close();}
});
