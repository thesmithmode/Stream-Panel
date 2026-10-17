import test from 'node:test';import assert from 'node:assert/strict';
import {startAnalyticsWarmer} from '../src/analytics-warmer.js';
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
test('warming catches up serially, backs off when ready and stops without scheduling more work',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0,failures=0,enabled=false;
 const runtime={configuration:{value:{excludedBotLogins:[],youtubeAccountId:'yt'}},db:{call:async()=>({preparing:++calls===1})}} as any;
 const stop=startAnalyticsWarmer(()=>[runtime],()=>enabled,()=>failures++);
 try{
  assert.equal(calls,0);enabled=true;t.mock.timers.tick(60000);await settle();assert.equal(calls,1);
  t.mock.timers.tick(4999);await settle();assert.equal(calls,1);t.mock.timers.tick(1);await settle();assert.equal(calls,2);
  t.mock.timers.tick(59999);await settle();assert.equal(calls,2);t.mock.timers.tick(1);await settle();assert.equal(calls,3);assert.equal(failures,0);
  stop();t.mock.timers.tick(60000);await settle();assert.equal(calls,3);
 }finally{stop();t.mock.timers.reset();}
});
test('a failing profile does not block peers and stopping an in-flight warm does not rearm the timer',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let failures=0,calls=0,release!:(value:{preparing:boolean})=>void;
 const cfg={excludedBotLogins:[],twitch:{userId:'owner'},youtube:{userId:'youtube'}};
 const broken={configuration:{value:cfg},db:{call:async()=>{throw Error('unavailable');}}},active={configuration:{value:cfg},db:{call:()=>{calls++;return new Promise(resolve=>{release=resolve;});}}};
 const stop=startAnalyticsWarmer(()=>[broken,active,active] as any,()=>true,()=>failures++);
 await settle();assert.equal(failures,1);assert.equal(calls,1);t.mock.timers.tick(60000);await settle();assert.equal(calls,1,'no overlapping background jobs');
 stop();release({preparing:true});await settle();t.mock.timers.tick(60000);await settle();assert.equal(calls,1);t.mock.timers.reset();
});
