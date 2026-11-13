import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerStreamsRoutes} from '../src/streams-routes.js';
test('audience response includes following before rendering and validates following changes in its ETag',async()=>{
 const app=Fastify();let name='Alice';const calls:any[]=[];
 registerStreamsRoutes(app,{call:async(method:string,...args:any[])=>{
  calls.push([method,...args]);
  if(method==='analytics')return {filters:{fromMs:100,toMs:200},audience:[]};
  if(method==='followerChanges')return {newFollowers:[{name}],unfollowers:[],platforms:[]};
  throw Error(method);
 }} as any,{value:{excludedBotLogins:['bot']}} as any);
 try{
  const path='/api/v1/analytics?panel=audience&from=100&to=200';
  const first=await app.inject(path);assert.equal(first.statusCode,200);assert.equal(first.json().following.newFollowers[0].name,'Alice');
  assert.deepEqual(calls.find(row=>row[0]==='followerChanges'),['followerChanges',100,200,['bot']]);
  name='Bob';const next=await app.inject({url:path,headers:{'if-none-match':first.headers.etag!}});assert.equal(next.statusCode,200);assert.equal(next.json().following.newFollowers[0].name,'Bob');assert.notEqual(next.headers.etag,first.headers.etag);
 }finally{await app.close();}
});
