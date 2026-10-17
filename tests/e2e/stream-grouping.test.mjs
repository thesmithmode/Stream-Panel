import test from 'node:test';
import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {acceptConfirmation} from '../helpers/confirmation.mjs';
test('select completed streams, cancel, merge and unmerge on mobile without losing originals',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  const at=Date.now()-6*3600000,ids=[];
  for(let n=0;n<2;n++){const start=at+n*2*3600000,id=await app.db.call('startSession','owner',`part-${n}`,start,'platform',start);ids.push(id);await app.db.call('endSession',id,start+120000);}
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(7000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await goto(page,app.bootstrap());await page.getByRole('button',{name:'Стримы',exact:true}).click();
  await page.getByRole('checkbox',{name:'Выбрать стрим',exact:true}).nth(0).check();await page.getByRole('checkbox',{name:'Выбрать стрим',exact:true}).nth(1).check();
  await page.getByRole('button',{name:'Объединить выбранные',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Отмена',exact:true}).click();assert.equal((await app.db.call('sessions')).length,2);
  await page.getByRole('button',{name:'Объединить выбранные',exact:true}).click();await acceptConfirmation(page,'Объединить');
  await page.getByRole('button',{name:'Разъединить',exact:true}).waitFor();assert.equal((await app.db.call('sessions')).length,1);
  for(const width of [390,1280]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  await page.getByRole('button',{name:'Разъединить',exact:true}).click();await acceptConfirmation(page,'Разъединить');
  await page.getByRole('checkbox',{name:'Выбрать стрим',exact:true}).nth(1).waitFor();assert.equal((await app.db.call('sessions')).length,2);assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
test('a current stream is selectable, remains selected after refresh and merges into earlier parts',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  const m=60000,at=Date.now()-20*m,older=await app.db.call('startSession','owner','older',at,'platform',at);await app.db.call('endSession',older,at+10*m);
  const live=await app.db.call('startSession','owner','live',at+10*m-1000,'platform',at+10*m-1000);
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(7000);await goto(page,app.bootstrap());await page.getByRole('button',{name:'Стримы',exact:true}).click();
  await page.locator(`tr[data-session-id="${live}"]`).getByRole('checkbox',{name:'Выбрать стрим',exact:true}).check();
  await page.locator(`tr[data-session-id="${older}"]`).getByRole('checkbox',{name:'Выбрать стрим',exact:true}).check();
  await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await page.getByText('Выбрано: 2',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Объединить выбранные',exact:true}).click();await acceptConfirmation(page,'Объединить');
  await page.getByText('Объединено частей: 2',{exact:true}).waitFor();const rows=await app.db.call('sessions');assert.equal(rows.length,1);assert.equal(rows[0].ended_at_ms,null);assert.equal((await app.db.call('activeLogicalStream')).id,live);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.getByRole('button',{name:'Разъединить',exact:true}).click();await acceptConfirmation(page,'Разъединить');await page.locator(`tr[data-session-id="${live}"]`).waitFor();assert.equal((await app.db.call('sessions')).length,2);assert.equal((await app.db.call('activeLogicalStream')).id,live);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
test('phone stream cards stay compact with full-width day headings and usable group actions',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  const m=60000,at=Date.now()-5*3600000,ids=[];
  for(let n=0;n<3;n++){
   const start=at+n*90*m,id=await app.db.call('startSession','owner',`compact-${n}`,start,'platform',start);ids.push(id);
   await app.db.call('attachPlatformStream',id,'youtube','yt',`video-${n}`,start,start,`https://youtube.com/watch?v=video-${n}`,'Дота 2, женщина кери научите играть');
   if(n<2)await app.db.call('endSession',id,start+30*m);
  }
  await app.db.call('mergeSessions',ids.slice(0,2));
  browser=await launchBrowser();const page=await browser.newPage();page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await goto(page,app.bootstrap());await page.getByRole('button',{name:'Стримы',exact:true}).click();
  for(const width of [360,390,720,1280]){
   await page.setViewportSize({width,height:900});
   const live=page.locator(`tr[data-session-id="${ids[2]}"]`),group=page.locator(`tr[data-session-id="${ids[0]}"]`);
   await live.getByRole('button',{name:'Открыть',exact:true}).waitFor();
   const boxes=await page.evaluate(()=>{
    const rows=[...document.querySelectorAll('tr[data-session-id]')];
    return {overflow:document.documentElement.scrollWidth>innerWidth,heights:rows.map(row=>row.getBoundingClientRect().height),heading:document.querySelector('.session-group th').getBoundingClientRect().width,table:document.querySelector('.sessions-page table').getBoundingClientRect().width};
   });
   assert.equal(boxes.overflow,false,JSON.stringify({width,...boxes}));
   if(width<=720){assert.ok(boxes.heights[0]<290,JSON.stringify({width,...boxes}));assert.ok(boxes.heights[1]<370,JSON.stringify({width,...boxes}));assert.ok(boxes.heading>=boxes.table-2,JSON.stringify({width,...boxes}));}
   for(const button of [live.getByRole('button',{name:'Открыть',exact:true}),group.getByRole('button',{name:'Разъединить',exact:true})]){await button.scrollIntoViewIfNeeded();const box=await button.boundingBox();assert.ok(box&&box.width>=36&&box.height>=32&&box.x>=0&&box.x+box.width<=width,JSON.stringify({width,box}));assert.equal(await button.evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);return range.getClientRects().length;}),1,'action text must fit on one line');}
   if(process.env.STREAM_PANEL_BROWSER_COVERAGE_DIR&&[390,1280].includes(width)){
    const {mkdir}=await import('node:fs/promises');const {join}=await import('node:path');await mkdir(process.env.STREAM_PANEL_BROWSER_COVERAGE_DIR,{recursive:true});await page.screenshot({path:join(process.env.STREAM_PANEL_BROWSER_COVERAGE_DIR,`compact-streams-${width}.png`),fullPage:true});
   }
  }
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
