import test from 'node:test';import assert from 'node:assert/strict';
import {TwitchConnection} from '../src/twitch.js';import {YouTubeConnection} from '../src/youtube.js';import type {Configuration} from '../src/config.js';import type {StoreClient} from '../src/db.js';
const at=Date.UTC(2026,9,10,12);
test('Twitch followers paginate, preserve dates, throttle, distinguish truncated lists and survive cancellation or failure',async()=>{
 for(const mode of ['ok','fallback','missing-scope','invalid','missing-id','loop','partial','network','cancel-request','cancel-store']){
  let valid=true,requests=0;const writes:any[]=[];
  const config={value:{twitchClientId:'client123',twitch:{access:'fixture',userId:'owner',scopes:mode==='missing-scope'?[]:['moderator:read:followers']}},save:async()=>{}} as unknown as Configuration;
  const db={call:async(method:string,...args:any[])=>{writes.push([method,...args]);if(mode==='cancel-store')valid=false;}} as unknown as StoreClient;
  const request:typeof fetch=async input=>{
   const url=new URL(String(input));assert.equal(url.searchParams.get('broadcaster_id'),'owner');assert.equal(url.searchParams.get('first'),'100');requests++;
   if(mode==='network')throw new Error('offline');if(mode==='cancel-request')valid=false;
   return Response.json(mode==='invalid'?{}:{total:mode==='fallback'?'bad':2,data:[mode==='missing-id'?{}:{user_id:String(requests),...(mode==='fallback'?{user_login:requests===1?'login':''}:{user_name:'Viewer'}),followed_at:mode==='fallback'?'bad':new Date(at).toISOString()}],pagination:{cursor:mode==='loop'?'same':mode==='partial'?String(requests):requests===1?'next':''}});
  };
  const c=new TwitchConnection(config,db,request);const runtime=c as unknown as {collectFollowers(account:string,current:()=>boolean,at:number):Promise<void>};
  try{
   await runtime.collectFollowers('owner',()=>valid,at);
   if(['ok','fallback','partial','cancel-store'].includes(mode)){
    assert.equal(writes[0][0],'followingSnapshot');assert.equal(writes[0][4],mode!=='partial');assert.equal(writes[0][3][0].followedAtMs,mode==='fallback'?null:at);
    if(mode==='ok'){await runtime.collectFollowers('owner',()=>valid,at+60000);assert.equal(requests,2);assert.equal(c.status.capabilities.followers,'Подписки проверены');}
   }else assert.equal(writes.length,0,mode);
  }finally{await c.stop();}
 }
});
test('YouTube subscriber collection paginates and stores available subscribers without treating a hidden subscription as negative',async()=>{
 for(const mode of ['ok','fallback','cached','invalid','missing-id','loop','partial','network','cancel-read','cancel-request','cancel-store']){
  let valid=true,requests=0;const writes:any[]=[];const tokens={access:'fixture',refresh:'fixture',expiresAt:at+3600000,userId:'channel',scopes:[]};
  const config={value:{youtube:tokens},save:async()=>{}} as unknown as Configuration;
  const db={call:async(method:string,...args:any[])=>{
   if(method==='youtubeQuota')return true;if(method==='youtubeData'){if(mode==='cancel-read')valid=false;return {snapshots:mode==='cached'?{'cursor:followers':{updatedAt:at}}:{}};}
   writes.push([method,...args]);if(mode==='cancel-store')valid=false;
  }} as unknown as StoreClient;
  const request:typeof fetch=async input=>{
   const url=new URL(String(input));assert.equal(url.searchParams.get('mySubscribers'),'true');requests++;
   if(mode==='network')throw new Error('offline');if(mode==='cancel-request')valid=false;
   return Response.json(mode==='invalid'?{}:{items:[mode==='missing-id'?{}:{subscriberSnippet:{channelId:String(requests),title:mode==='fallback'?'':'Subscriber'},snippet:{publishedAt:mode==='fallback'?'bad':new Date(at).toISOString()}}],nextPageToken:mode==='loop'?'same':mode==='partial'?String(requests):requests===1?'next':''});
  };
  const c=new YouTubeConnection(config,db,'https://panel.test/callback','ruslan',request,()=>at);const runtime=c as unknown as {collectSubscribers(tokens:any,valid:()=>boolean,at:number):Promise<void>};
  try{
   await runtime.collectSubscribers(tokens,()=>valid,at);
   if(['ok','fallback','partial','cancel-store'].includes(mode)){assert.equal(writes[0][0],'followingSnapshot');assert.equal(writes[0][4],mode!=='partial');assert.equal(writes[0][3][0].followedAtMs,mode==='fallback'?null:at);}
   else if(['invalid','missing-id','loop','network'].includes(mode))assert.equal(writes[0][0],'gap');else assert.equal(writes.length,0,mode);
  }finally{await c.stop();}
 }
});
