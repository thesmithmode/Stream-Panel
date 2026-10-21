import test from 'node:test';
import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';
test('compact analytics and lazy clock endpoint preserve full API, filters, validation and exact selected buckets',async()=>{
 const a=await application();try{
  const host=new URL(a.origin).host,key=a.bootstrap().split('#key=')[1];
  const auth=await a.app.inject({method:'POST',url:'/api/v1/bootstrap',headers:{host,origin:a.origin},payload:{key}});
  const headers={host,cookie:auth.cookies.map(c=>`${c.name}=${c.value}`).join('; ')};
  const at=Date.now()-86400000,id=await a.db.call('startSession','owner','clock',at,'platform',at);
  await a.db.call('streamSample',id,at,'game','Game','',10);await a.db.call('endSession',id,at+3600000);
  const query=new URLSearchParams({from:'0',to:String(Date.now()),mode:'summary',insights:'1',timezone:'Europe/Moscow'});
  const read=async(path,q=query)=>{for(let n=0;n<100;n++){const response=await a.app.inject({headers,url:`/api/v1/${path}?${q}`});assert.equal(response.statusCode,200,response.body);const result=response.json();if(!result.preparing)return result;}throw Error('not ready');};
  const full=await read('analytics');query.set('clockCompact','1');
  const compact=await read('analytics');assert.deepEqual(compact.summary,full.summary);assert.ok(compact.clockBuckets.length<full.clockBuckets.length/3);
  assert.deepEqual(compact.clockSelection,{day:'all',resolution:15});
  for(const day of ['all','weekdays','weekends','пн','вт','ср','чт','пт','сб','вс'])for(const resolution of [1,5,15,30,60]){
   query.set('clockDay',day);query.set('clockResolution',String(resolution));const detail=await read('analytics/clock-summary');
   assert.deepEqual(detail.clockBuckets.filter(b=>b.day===day&&b.resolution===resolution),full.clockBuckets.filter(b=>b.day===day&&b.resolution===resolution));
   assert.deepEqual(detail.filters,full.filters);assert.equal(detail.clockRevision,full.clockRevision);assert.equal(detail.audience,undefined);assert.equal(detail.activityClock,undefined);assert.equal(detail.timeline,undefined);
  }
  query.set('clockResolution','2');const invalid=await a.app.inject({headers,url:`/api/v1/analytics/clock-summary?${query}`});assert.equal(invalid.statusCode,400);
 }finally{await a.close();}
});
