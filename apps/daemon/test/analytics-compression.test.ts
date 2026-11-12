import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {gunzipSync} from 'node:zlib';
import {randomBytes} from 'node:crypto';
import {registerAnalyticsCompression} from '../src/analytics-compression.js';
test('large report compression preserves exact JSON and respects HTTP negotiation',async()=>{
 const app=Fastify();registerAnalyticsCompression(app);
 const body={summary:{messages:0,average:null},clockBuckets:Array.from({length:1000},(_,minute)=>({day:'пн',minute,airtimeMs:60000,personTimeMs:0,averageAudience:0,people:[]}))};
 app.get('/api/v1/analytics',async(_request,reply)=>reply.header('Cache-Control','no-store').header('Vary','Origin').send(body));
 try{
  for(const encoding of ['gzip','br, GZip; q=0.5','*;q=1']){
   const r=await app.inject({url:'/api/v1/analytics?from=1',headers:{'accept-encoding':encoding}});
   assert.equal(r.headers['content-encoding'],'gzip');assert.equal(r.headers['vary'],'Origin, Accept-Encoding');assert.equal(r.headers['cache-control'],'no-store');
   assert.deepEqual(JSON.parse(gunzipSync(r.rawPayload).toString()),body);
   assert.ok(r.rawPayload.length<Buffer.byteLength(JSON.stringify(body))/4);
   assert.equal(Number(r.headers['content-length']),r.rawPayload.length);
  }
  for(const encoding of [undefined,'br','gzip;q=0, *;q=1','gzip;q=invalid','gzip;q=2','*;q=0']){
   const r=await app.inject({url:'/api/v1/analytics',headers:encoding?{'accept-encoding':encoding}:{}});
   assert.equal(r.headers['content-encoding'],undefined);assert.deepEqual(r.json(),body);
  }
 }finally{await app.close();}
});
test('compression skips small, unrelated, pre-encoded, failed, and incompressible responses',async()=>{
 const app=Fastify();registerAnalyticsCompression(app);
 const text=randomBytes(12000);
 app.get('/api/v1/analytics',async request=>(request.query as any).small?{messages:0}:text);
 app.get('/api/v1/analytics/clock',async(_request,reply)=>reply.header('Content-Encoding','br').send('already encoded'));
 app.get('/api/v1/analytics/audience',async(_request,reply)=>reply.code(503).send({error:'FAILED',padding:'x'.repeat(10000)}));
 app.get('/api/v1/status',async()=>({csrf:'x'.repeat(10000)}));
 try{
  for(const url of ['/api/v1/analytics?small=1','/api/v1/analytics','/api/v1/analytics/audience','/api/v1/status']){
   const r=await app.inject({url,headers:{'accept-encoding':'gzip'}});
   assert.equal(r.headers['content-encoding'],undefined);
  }
  const r=await app.inject({url:'/api/v1/analytics/clock',headers:{'accept-encoding':'gzip'}});assert.equal(r.headers['content-encoding'],'br');assert.equal(r.body,'already encoded');
 }finally{await app.close();}
});
test('clock-summary uses identical cached gzip bytes and still honors a later identity request',async()=>{
 const {PreparedResponses}=await import('../src/conditional-response.js');
 const app=Fastify();registerAnalyticsCompression(app);const cache=new PreparedResponses();let loads=0,revision=1;
 app.get('/api/v1/analytics/clock-summary',(request,reply)=>cache.respond(request,reply,String(revision),async()=>{loads++;return {clockBuckets:Array.from({length:300},(_,minute)=>({minute,people:revision,messages:0}))};}));
 try{
  const first=await app.inject({url:'/api/v1/analytics/clock-summary',headers:{'accept-encoding':'gzip'}});
  const repeat=await app.inject({url:'/api/v1/analytics/clock-summary',headers:{'accept-encoding':'gzip'}});
  assert.equal(first.headers['content-encoding'],'gzip');assert.deepEqual(repeat.rawPayload,first.rawPayload);assert.equal(loads,1);
  const plain=await app.inject({url:'/api/v1/analytics/clock-summary',headers:{'accept-encoding':'gzip;q=0'}});assert.equal(plain.headers['content-encoding'],undefined);assert.deepEqual(plain.json(),JSON.parse(gunzipSync(first.rawPayload).toString()));
  const unchanged=await app.inject({url:'/api/v1/analytics/clock-summary',headers:{'if-none-match':first.headers.etag!,'accept-encoding':'gzip'}});assert.equal(unchanged.statusCode,304);assert.equal(unchanged.rawPayload.length,0);assert.equal(loads,1);
  revision++;const changed=await app.inject({url:'/api/v1/analytics/clock-summary',headers:{'accept-encoding':'gzip','if-none-match':first.headers.etag!}});assert.equal(changed.statusCode,200);assert.notEqual(changed.headers.etag,first.headers.etag);
 }finally{await app.close();}
});
