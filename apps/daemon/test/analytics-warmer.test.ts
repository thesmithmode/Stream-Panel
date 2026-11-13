import test from 'node:test';import assert from 'node:assert/strict';
import {startAnalyticsWarmer} from '../src/analytics-warmer.js';
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const changes=(revision:number)=>({versions:{activity:revision,people:0,donations:0,follows:0}});
test('both profiles warm after restart while collection and visible requests take priority',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0,pending=1;
 const runtime={configuration:{value:{excludedBotLogins:[]}},db:{queueStatus:()=>({pending}),call:async(method:string)=>method==='analytics'?{preparing:false}:method==='changes'?changes(1):method==='advanceAnalytics'?{pending:0}:(calls++,{preparing:false})}};
 const stop=startAnalyticsWarmer(()=>[runtime] as any,()=>true,()=>{});
 try{await settle();assert.equal(calls,0);t.mock.timers.tick(250);await settle();assert.equal(calls,0);pending=0;t.mock.timers.tick(250);await settle();assert.equal(calls,1);}finally{stop();t.mock.timers.reset();}
});
test('warming finishes serially and leaves unchanged facts alone until a new revision',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0,failures=0,enabled=false,revision=1;
 const runtime={configuration:{value:{excludedBotLogins:[],youtubeAccountId:'yt'}},db:{call:async(method:string)=>method==='analytics'?{preparing:false}:method==='changes'?changes(revision):method==='advanceAnalytics'?{pending:0}:({preparing:++calls===1})}} as any;
 const stop=startAnalyticsWarmer(()=>[runtime],()=>enabled,()=>failures++);
 try{enabled=true;t.mock.timers.tick(60000);await settle();assert.equal(calls,1);t.mock.timers.tick(250);await settle();assert.equal(calls,2);t.mock.timers.tick(60000);await settle();assert.equal(calls,2);revision++;t.mock.timers.tick(60000);await settle();assert.equal(calls,3);assert.equal(failures,0);stop();t.mock.timers.tick(60000);await settle();assert.equal(calls,3);}finally{stop();t.mock.timers.reset();}
});
test('a failing viewed profile does not block peers; stopping an in-flight warm does not rearm it',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let failures=0,calls=0,release!:(value:{preparing:boolean})=>void;
 const cfg={excludedBotLogins:[],twitch:{userId:'owner'},youtube:{userId:'youtube'}};
 const broken={configuration:{value:cfg},db:{call:async()=>{throw Error('unavailable');}}},active={configuration:{value:cfg},db:{call:(method:string)=>method==='changes'?Promise.resolve(changes(1)):method==='advanceAnalytics'?Promise.resolve({pending:0}):(calls++,new Promise(resolve=>release=resolve))}};
 const stop=startAnalyticsWarmer(()=>[broken,active,active] as any,()=>true,()=>failures++);
 await settle();assert.equal(failures,1);assert.equal(calls,1);t.mock.timers.tick(60000);await settle();assert.equal(calls,1);stop();release({preparing:true});await settle();t.mock.timers.tick(60000);await settle();assert.equal(calls,1);t.mock.timers.reset();
});
test('shutdown cancels pending preparation without reporting a database failure or starting another operation',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let reject!:(error:Error)=>void,calls=0,failures=0;
 const runtime={configuration:{value:{excludedBotLogins:[]}},db:{call:()=>{calls++;return new Promise((_,failed)=>{reject=failed;});}}};
 const stop=startAnalyticsWarmer(()=>[runtime] as any,()=>true,()=>failures++);stop();reject(new Error('DB_WORKER_STOPPED'));await settle();t.mock.timers.tick(60000);await settle();
 assert.equal(calls,1);assert.equal(failures,0);t.mock.timers.reset();
});
test('changing highlighting does not rebuild reports and the selected bot mode is warmed separately',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0,last:unknown;
 const cfg={excludedBotLogins:[],analyticsSettings:{highlightBots:true,highlightHumans:true,includeBots:false}};
 const runtime={configuration:{value:cfg},db:{call:async(method:string,options?:unknown)=>method==='analytics'?{preparing:false}:method==='changes'?changes(1):method==='advanceAnalytics'?{pending:0}:(last=options,calls++,{preparing:false})}};
 const stop=startAnalyticsWarmer(()=>[runtime] as any,()=>true,()=>{});
 try{
  await settle();assert.equal(calls,1);assert.equal('highlightBots' in (last as object),false);
  cfg.analyticsSettings.highlightBots=false;cfg.analyticsSettings.highlightHumans=false;t.mock.timers.tick(60000);await settle();assert.equal(calls,1);
  cfg.analyticsSettings.includeBots=true;t.mock.timers.tick(60000);await settle();assert.equal(calls,2);assert.equal((last as {excludedLogins:unknown}).excludedLogins,false);
 }finally{stop();t.mock.timers.reset();}
});
test('committed changes wake the idle warmer, coalesce bursts and detach on shutdown',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let revision=1,calls=0,listener:(()=>void)|undefined,detached=false;
 const runtime={configuration:{value:{excludedBotLogins:[]}},db:{onChange:(next:()=>void)=>{listener=next;return ()=>{detached=true;listener=undefined;};},call:async(method:string)=>method==='analytics'?{preparing:false}:method==='changes'?changes(revision):method==='advanceAnalytics'?{pending:0}:(calls++,{preparing:false})}};
 const stop=startAnalyticsWarmer(()=>[runtime] as any,()=>true,()=>{});
 try{await settle();assert.equal(calls,1);revision++;listener!();listener!();t.mock.timers.tick(250);await settle();assert.equal(calls,2);stop();assert.equal(detached,true);t.mock.timers.tick(60000);await settle();assert.equal(calls,2);}finally{stop();t.mock.timers.reset();}
});
test('standard windows retain bounds across slices and finish before the revision is marked warm',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const requests:any[]=[];let warmCalls=0;
 const runtime={configuration:{value:{excludedBotLogins:[]}},db:{call:async(method:string,options:any)=>{
  if(method==='changes')return changes(1);
  if(method==='advanceAnalytics')return {pending:0};
  if(method==='warmAnalytics'){warmCalls++;return {preparing:false};}
  requests.push(options);return {preparing:requests.length===1};
 }}};
 const stop=startAnalyticsWarmer(()=>[runtime] as any,()=>true,()=>{});
 try{
  await settle();assert.equal(requests.length,1);
  t.mock.timers.tick(250);await settle();assert.equal(requests.length,2);assert.equal(requests[0].toMs,requests[1].toMs);
  t.mock.timers.tick(250);await settle();assert.equal(requests.length,3);assert.equal(warmCalls,1);
  assert.equal(requests[0].toMs-requests[0].fromMs,7*86400000);assert.equal(requests[2].toMs-requests[2].fromMs,30*86400000);
  t.mock.timers.tick(60000);await settle();assert.equal(requests.length,3);
 }finally{stop();t.mock.timers.reset();}
});
