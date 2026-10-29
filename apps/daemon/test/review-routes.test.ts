import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {StreamStore} from '../../../packages/core/src/store.js';
import {registerPeopleRoutes} from '../src/people-routes.js';
import {conditionalResponse} from '../src/conditional-response.js';
test('compact people options and person analytics cross the route contract',async()=>{
 const store=new StreamStore(':memory:'),app=Fastify(),at=Date.now()-3600000;
 const db={call:async(method:string,...args:unknown[])=>{const fn=(store as unknown as Record<string,(...a:unknown[])=>unknown>)[method]!;return fn.apply(store,args);}} as Parameters<typeof registerPeopleRoutes>[1];
 const configuration={value:{analyticsSettings:{},excludedBotLogins:[]}} as unknown as Parameters<typeof registerPeopleRoutes>[2];registerPeopleRoutes(app,db,configuration);app.setErrorHandler((error,_request,reply)=>reply.code(400).send({error:error instanceof Error?error.message:String(error)}));
 try{
  const sid=store.startSession('owner','route',at,'platform',at);store.recordPoll(sid,'owner',{startedAtMs:at,completedAtMs:at+60000,status:'complete',userIds:['viewer'],userNames:{viewer:'Viewer'}});store.endSession(sid,at+120000);const id=String(store.persons()[0]!.id);
  const options=await app.inject({url:'/api/v1/persons/options?search=Viewer&limit=1&includeBots=1&selected='+id});assert.equal(options.statusCode,200);assert.equal(options.json().items[0].id,id);assert.equal(options.json().selectedItem.id,id);
  const detail=await app.inject({url:`/api/v1/persons/${id}/analytics?from=${at}&to=${at+120000}&source=twitch&timezone=UTC`});assert.equal(detail.statusCode,200);assert.equal(detail.json().audience.length,1);assert.equal(detail.json().timeline[0].presenceKnown,true);
  assert.equal((await app.inject({url:`/api/v1/persons/${id}/analytics?from=invalid&to=2`})).statusCode,400);assert.equal((await app.inject({url:'/api/v1/persons/options?limit=51'})).statusCode,400);
 }finally{await app.close();store.close();}
});
test('analytics block validators keep body and ETag stable without a second serialization',async()=>{
 const app=Fastify(),value={timeline:Array.from({length:1000},(_,at)=>({at,observed:1})),summary:{core:1},optional:undefined};app.get('/analytics',(request,reply)=>conditionalResponse(request,reply,value));
 try{
  const first=await app.inject('/analytics');assert.equal(first.body,JSON.stringify(value));assert.equal(Number(first.headers['x-stream-panel-bytes']),Buffer.byteLength(first.body));const blocks=JSON.parse(String(first.headers['x-stream-panel-blocks']));assert.equal(typeof blocks.timeline,'string');assert.equal(blocks.optional,undefined);
  value.summary.core=2;const second=await app.inject('/analytics');const next=JSON.parse(String(second.headers['x-stream-panel-blocks']));assert.equal(next.timeline,blocks.timeline);assert.notEqual(next.summary,blocks.summary);assert.notEqual(second.headers.etag,first.headers.etag);
  const cached=await app.inject({url:'/analytics',headers:{'if-none-match':String(second.headers.etag)}});assert.equal(cached.statusCode,304);
 }finally{await app.close();}
});
