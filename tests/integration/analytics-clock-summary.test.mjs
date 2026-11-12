import {clockActivitySeries,clockDonationSeries} from '../../dist/packages/core/src/clock-activity.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';
test('compact analytics and lazy clock endpoint preserve full API, filters, validation and exact selected buckets',async()=>{
 const a=await application();try{
  const host=new URL(a.origin).host,key=a.bootstrap().split('#key=')[1];
  const auth=await a.app.inject({method:'POST',url:'/api/v1/bootstrap',headers:{host,origin:a.origin},payload:{key}});
  const headers={host,cookie:auth.cookies.map(c=>`${c.name}=${c.value}`).join('; ')};
  const at=Date.now()-86400000,id=await a.db.call('startSession','owner','clock',at,'platform',at);
  await a.db.call('streamSample',id,at,'game','Game','',11);await a.db.call('endSession',id,at+3600000);
  const query=new URLSearchParams({from:'0',to:String(Date.now()),mode:'summary',insights:'1',timezone:'Europe/Moscow'});
  const read=async(path,q=query)=>{for(let n=0;n<100;n++){const response=await a.app.inject({headers,url:`/api/v1/${path}?${q}`});assert.equal(response.statusCode,200,response.body);const result=response.json();if(!result.preparing)return result;}throw Error('not ready');};
  const full=await read('analytics');query.set('clockCompact','1');
  const compact=await read('analytics');assert.deepEqual(compact.summary,full.summary);assert.ok(compact.clockBuckets.length<full.clockBuckets.length/3);
  assert.deepEqual(compact.clockSelection,{day:'all',resolution:15});
  query.set('clockActivityCompact','1');
  for(const day of ['all','weekdays','weekends','пн','вт','ср','чт','пт','сб','вс'])for(const resolution of [1,5,15,30,60]){
   query.set('clockDay',day);query.set('clockResolution',String(resolution));const detail=await read('analytics/clock-summary');
   assert.deepEqual(detail.clockBuckets.filter(b=>b.day===day&&b.resolution===resolution),full.clockBuckets.filter(b=>b.day===day&&b.resolution===resolution));
   assert.ok(detail.activityClock.length<=1440/resolution);
   for(const metric of ['viewers','messages','watchHours'])assert.deepEqual(clockActivitySeries(detail.activityClock,metric,resolution,day,true),clockActivitySeries(full.activityClock,metric,resolution,day,true));
   assert.deepEqual(clockDonationSeries(detail.activityClock,'RUB',resolution,day),clockDonationSeries(full.activityClock,'RUB',resolution,day));
   assert.deepEqual(detail.filters,full.filters);assert.equal(detail.clockRevision,full.clockRevision);assert.equal(detail.audience,undefined);assert.ok(Array.isArray(detail.activityClock));assert.ok(Array.isArray(detail.clockCurrencies));assert.equal(detail.timeline,undefined);
  }
  query.set('clockResolution','2');const invalid=await a.app.inject({headers,url:`/api/v1/analytics/clock-summary?${query}`});assert.equal(invalid.statusCode,400);
 }finally{await a.close();}
});
