import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {conditionalResponse} from '../src/conditional-response.js';
test('private report validators return 304 only for an identical authorized projection',async()=>{
 const app=Fastify();app.get('/',(request,reply)=>conditionalResponse(request,reply,{profile:request.headers['x-stream-panel-profile'],value:1}));
 try{const first=await app.inject({url:'/',headers:{'x-stream-panel-profile':'ruslan'}});assert.equal(first.statusCode,200);const etag=first.headers.etag!;assert.equal(first.headers['cache-control'],'private, no-cache');
 const unchanged=await app.inject({url:'/',headers:{'x-stream-panel-profile':'ruslan','if-none-match':etag}});assert.equal(unchanged.statusCode,304);assert.equal(unchanged.body,'');
 const peer=await app.inject({url:'/',headers:{'x-stream-panel-profile':'gulnaz','if-none-match':etag}});assert.equal(peer.statusCode,200);assert.notEqual(peer.headers.etag,etag);
 }finally{await app.close();}
});

test('prepared responses skip loading/serialization for a matching version and invalidate exact keys',async()=>{
 const {PreparedResponses}=await import('../src/conditional-response.js');
 const cache=new PreparedResponses(1000),app=Fastify();let version=1,loads=0,serializations=0,preparing=false;
 app.get('/api/v1/analytics', (request,reply)=>cache.respond(request,reply,`${request.headers['x-stream-panel-profile']}:${version}:${JSON.stringify(request.query)}`,async()=>{loads++;return preparing?{preparing:true}:{summary:{toJSON(){serializations++;return {version};}}};}));
 try{
  const first=await app.inject('/api/v1/analytics?source=twitch');
  const unchanged=await app.inject({url:'/api/v1/analytics?source=twitch',headers:{'if-none-match':`W/${first.headers.etag}`}});
  assert.equal(unchanged.statusCode,304);assert.equal(unchanged.body,'');assert.equal(loads,1);assert.equal(serializations,1);
  version++;const changed=await app.inject({url:'/api/v1/analytics?source=twitch',headers:{'if-none-match':first.headers.etag!}});assert.equal(changed.statusCode,200);assert.notEqual(changed.headers.etag,first.headers.etag);
  await app.inject('/api/v1/analytics?source=youtube');await app.inject({url:'/api/v1/analytics?source=twitch',headers:{'x-stream-panel-profile':'peer'}});assert.equal(loads,4);
  preparing=true;version++;await app.inject('/api/v1/analytics');await app.inject('/api/v1/analytics');assert.equal(loads,6);
 }finally{await app.close();}
});
test('prepared response memory budget evicts old keys and bypasses live snapshots',async()=>{
 const {PreparedResponses}=await import('../src/conditional-response.js');
 const cache=new PreparedResponses(30),app=Fastify();let loads=0;
 app.get('/',(request,reply)=>cache.respond(request,reply,(request.query as any).live?undefined:request.url,async()=>({value:++loads})));
 try{await app.inject('/?a');await app.inject('/?b');await app.inject('/?c');await app.inject('/?d');await app.inject('/?a');assert.equal(loads,5);await app.inject('/?live=1');await app.inject('/?live=1');assert.equal(loads,7);}finally{await app.close();}
});
