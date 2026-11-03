import test from 'node:test';
import assert from 'node:assert/strict';
import {application,seed} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {navigate} from '../helpers/navigation.mjs';
for(const view of ['events','messages'])test(`${view} refresh retains rendered rows, scroll and selection while loading and after new data`,{timeout:60000},async()=>{
 const a=await application();let browser;
 try{
  const id=await seed(a);browser=await launchBrowser();const page=await browser.newPage({viewport:{width:view==='events'?1280:390,height:844}});page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const at=Date.now(),row=n=>({id:`row-${n}`,source:'twitch',type:'chat.message',actor_name:'Viewer',person_id:null,at_ms:at-n*1000,payload:{text:`Message ${n}: `+'Already loaded content. '.repeat(5)}});
  let result=Array.from({length:50},(_,i)=>row(i)),hold=false,release,arrived,fail=false;
  await page.route('**/api/v1/events/recent?*',async route=>{
   const q=new URL(route.request().url()).searchParams;assert.equal(q.get('messages'),view==='messages'?'1':null);
   if(hold)await new Promise(resolve=>{release=resolve;arrived();});
   await route.fulfill(fail?{status:400,json:{error:'Temporary archive failure'}}:{json:result});
  });
  await goto(page,a.bootstrap());
  if(view==='events'){await navigate(page,'Стримы');await page.locator(`[data-session-id="${id}"] .stream-open`).click();await page.getByRole('tab',{name:'События',exact:true}).click();}
  else{await navigate(page,'Люди');await page.locator('.person-row').filter({hasText:'Тестовый зритель'}).click();await page.getByRole('tab',{name:'Сообщения',exact:true}).click();}
  const list=page.locator('.recent-events');await page.waitForFunction(()=>document.querySelectorAll('.recent-events article').length===50);
  const anchor=list.locator('article').nth(20);await anchor.scrollIntoViewIfNeeded();
  await anchor.evaluate(el=>{window.refreshAnchor=el;const text=document.createTreeWalker(el.querySelector('.event-text'),NodeFilter.SHOW_TEXT).nextNode(),selection=getSelection(),range=document.createRange();range.setStart(text,0);range.setEnd(text,7);selection.removeAllRanges();selection.addRange(range);});
  const before=await page.evaluate(()=>({top:window.refreshAnchor.getBoundingClientRect().top,selection:getSelection().toString(),url:location.href}));
  for(const prepend of [false,true]){
   hold=true;release=undefined;const blocked=new Promise(resolve=>{arrived=resolve;});if(prepend)result=[row(-1),...result.slice(0,49)];
   await page.evaluate(()=>window.dispatchEvent(new Event('sp:clock-refresh')));await page.waitForFunction(()=>document.querySelector('.recent-events').getAttribute('aria-busy')==='true');await blocked;
   assert.equal(await list.locator('article').count(),50);assert.equal(await list.getByRole('status').count(),0);
   assert.equal(await page.evaluate(()=>window.refreshAnchor.isConnected),true);
   assert.ok(Math.abs(await page.evaluate(()=>window.refreshAnchor.getBoundingClientRect().top)-before.top)<1,'pending request preserves scroll');
   assert.ok(release);hold=false;release();await page.waitForFunction(()=>document.querySelector('.recent-events').getAttribute('aria-busy')==='false');
   const after=await page.evaluate(()=>({connected:window.refreshAnchor.isConnected,top:window.refreshAnchor.getBoundingClientRect().top,selection:getSelection().toString(),url:location.href}));
   assert.equal(after.connected,true);assert.equal(after.url,before.url);assert.equal(after.selection,before.selection);assert.ok(Math.abs(after.top-before.top)<1,'new rows preserve the visible anchor');
  }
  fail=true;await page.evaluate(()=>window.dispatchEvent(new Event('sp:clock-refresh')));await list.getByRole('alert').waitFor();assert.equal(await list.locator('article').count(),50);assert.equal(await page.evaluate(()=>window.refreshAnchor.isConnected),true);
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
