import test from 'node:test';import assert from 'node:assert/strict';import {requestJson,ConnectionError} from './request.ts';
test('reads recover from a disconnected browser and a maintenance response',async()=>{
 let calls=0;const fetcher=async()=>{calls++;if(calls===1)throw new TypeError('Failed to fetch');if(calls===2)return new Response('',{status:503});return Response.json({ok:true});};
 assert.deepEqual(await requestJson('/fixture',{},fetcher as typeof fetch,async()=>{}),{ok:true});assert.equal(calls,3);
});
test('writes never repeat; auth is not retried and unusable responses become a connection state',async()=>{
 let calls=0;const failed=async()=>{calls++;throw new TypeError('Failed to fetch');};
 await assert.rejects(requestJson('/fixture',{method:'POST'},failed as typeof fetch,async()=>{}),ConnectionError);assert.equal(calls,1);
 await assert.rejects(requestJson('/fixture',{},async()=>Response.json({error:'LOGIN_REQUIRED'},{status:401}),async()=>{}),/LOGIN_REQUIRED/);
 await assert.rejects(requestJson('/fixture',{},async()=>new Response('<html>Gateway</html>'),async()=>{}),ConnectionError);
 await assert.rejects(requestJson('/fixture',{},async()=>new Response('',{status:502}),async()=>{}),ConnectionError);
 await assert.rejects(requestJson('/fixture',{},failed as typeof fetch,async()=>{}),ConnectionError);
});

test('permanent server failures preserve actionable codes and supplied abort signals',async()=>{
 await assert.rejects(requestJson('/fixture',{},async()=>Response.json({error:'WORKER_UNAVAILABLE'},{status:503}),async()=>{}),/WORKER_UNAVAILABLE/);
 await assert.rejects(requestJson('/fixture',{},async()=>Response.json({},{status:503}),async()=>{}),ConnectionError);
 const signal=new AbortController().signal;await requestJson('/fixture',{signal},async(_url,init)=>{assert.ok(init?.signal);assert.equal(init?.cache,'no-store');assert.equal(init.signal.aborted,false);return Response.json({});});
 await assert.rejects(requestJson('/fixture',{},async()=>Response.json({},{status:400}),async()=>{}),/HTTP_400/);
});

test('cancelled navigation requests stop without retrying or reporting lost connectivity',async()=>{
 const controller=new AbortController();let calls=0,waits=0;
 const fetcher=async()=>{calls++;controller.abort();throw controller.signal.reason;};
 await assert.rejects(requestJson('/fixture',{signal:controller.signal},fetcher as typeof fetch,async()=>{waits++;}),{name:'AbortError'});
 assert.equal(calls,1);assert.equal(waits,0);
 await assert.rejects(requestJson('/fixture',{signal:controller.signal},fetcher as typeof fetch),{name:'AbortError'});
 assert.equal(calls,1);
});

test('a supplied navigation signal retains its own request deadline',async(t)=>{
 const external=new AbortController();let calls=0;
 t.mock.method(AbortSignal,'timeout',()=>{const deadline=new AbortController();queueMicrotask(()=>deadline.abort(new DOMException('Timeout','TimeoutError')));return deadline.signal;});
 const fetcher=async(_url:unknown,init?:RequestInit)=>{calls++;return new Promise<Response>((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true});});};
 await assert.rejects(requestJson('/slow',{signal:external.signal},fetcher as typeof fetch,async()=>{}),ConnectionError);assert.equal(calls,3);assert.equal(external.signal.aborted,false);
});

test('conditional reads reuse the exact profile snapshot on 304 and publish validators only after successful JSON',async()=>{
 const cached={value:3};let notified=0;
 const result=await requestJson('/report',{conditional:{etag:'"v1"',value:cached},onResponse:()=>notified++},async()=>new Response(null,{status:304}));
 assert.equal(result,cached);assert.equal(notified,0);
 await requestJson('/report',{onResponse:(response,value)=>{assert.equal(response.headers.get('etag'),'"v2"');assert.deepEqual(value,{value:4});notified++;}},async()=>new Response('{"value":4}',{headers:{etag:'"v2"'}}));
 assert.equal(notified,1);
});
