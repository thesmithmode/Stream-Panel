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
 const signal=new AbortController().signal;await requestJson('/fixture',{signal},async(_url,init)=>{assert.equal(init?.signal,signal);return Response.json({});});
 await assert.rejects(requestJson('/fixture',{},async()=>Response.json({},{status:400}),async()=>{}),/HTTP_400/);
});
