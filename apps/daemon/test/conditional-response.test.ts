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
