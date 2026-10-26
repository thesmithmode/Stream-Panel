import test from 'node:test';
import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
test('daily history loads only the displayed month and keeps older streams reachable',{timeout:60000},async()=>{
 const a=await application();let browser;
 try{
  const base=Date.now()-65*86400000;for(let i=0;i<65;i++){const at=base+i*86400000,id=await a.db.call('startSession','owner',String(i),at,'platform',at);await a.db.call('streamSample',id,at,'game','Game','',i%7);await a.db.call('endSession',id,at+60000);}
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await goto(page,a.bootstrap());const initial=page.waitForResponse(async r=>new URL(r.url()).pathname==='/api/v1/analytics'&&r.status()===200&&!(await r.json()).preparing);
  await page.getByRole('button',{name:'Аналитика',exact:true}).click();const first=await (await initial).json();assert.equal(first.streamRange.total,65);assert.ok(first.streamComparison.length<=32);
  const older=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/analytics'&&new URL(r.url()).searchParams.has('streamFrom'));
  await page.getByRole('button',{name:'Предыдущие дни',exact:true}).click();const response=await older,report=await response.json(),url=new URL(response.url());
  assert.ok(report.streamComparison.length>0&&report.streamComparison.length<=31);assert.ok(report.streamComparison.every(s=>s.startedAt>=Number(url.searchParams.get('streamFrom'))&&s.startedAt<Number(url.searchParams.get('streamTo'))));
  const comparison=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/analytics'&&new URL(r.url()).searchParams.has('streamOffset'));
  await page.getByText('Возвращаемость по эфирам',{exact:true}).click();assert.equal((await (await comparison).json()).streamComparison.length,7);
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
