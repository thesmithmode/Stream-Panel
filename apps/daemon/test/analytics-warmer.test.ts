import test from 'node:test';import assert from 'node:assert/strict';
import {startAnalyticsWarmer} from '../src/analytics-warmer.js';import {analyticsInterest,analyticsViewed} from '../src/analytics-interest.js';
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const changes=(revision:number)=>({versions:{activity:revision,people:0,donations:0,follows:0}});
test('unviewed profiles do no speculative work; collection and visible requests take priority',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0,pending=1;
 const runtime={configuration:{value:{excludedBotLogins:[]}},db:{queueStatus:()=>({pending}),call:async(method:string)=>method==='changes'?changes(1):(calls++,{preparing:false})}};
 const stop=startAnalyticsWarmer(()=>[runtime] as any,()=>true,()=>{});
 try{await settle();assert.equal(calls,0);analyticsInterest(runtime.db,'priority',true);t.mock.timers.tick(60000);await settle();assert.equal(calls,0);pending=0;t.mock.timers.tick(250);await settle();assert.equal(calls,1);}finally{stop();t.mock.timers.reset();}
});
test('warming finishes serially and leaves unchanged facts alone until a new revision',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0,failures=0,enabled=false,revision=1;
 const runtime={configuration:{value:{excludedBotLogins:[],youtubeAccountId:'yt'}},db:{call:async(method:string)=>method==='changes'?changes(revision):({preparing:++calls===1})}} as any;
 analyticsInterest(runtime.db,'serial',true);const stop=startAnalyticsWarmer(()=>[runtime],()=>enabled,()=>failures++);
 try{enabled=true;t.mock.timers.tick(60000);await settle();assert.equal(calls,1);t.mock.timers.tick(250);await settle();assert.equal(calls,2);t.mock.timers.tick(60000);await settle();assert.equal(calls,2);revision++;t.mock.timers.tick(60000);await settle();assert.equal(calls,3);assert.equal(failures,0);stop();t.mock.timers.tick(60000);await settle();assert.equal(calls,3);}finally{stop();t.mock.timers.reset();}
});
test('a failing viewed profile does not block peers; stopping an in-flight warm does not rearm it',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let failures=0,calls=0,release!:(value:{preparing:boolean})=>void;
 const cfg={excludedBotLogins:[],twitch:{userId:'owner'},youtube:{userId:'youtube'}};
 const broken={configuration:{value:cfg},db:{call:async()=>{throw Error('unavailable');}}},active={configuration:{value:cfg},db:{call:(method:string)=>method==='changes'?Promise.resolve(changes(1)):(calls++,new Promise(resolve=>release=resolve))}};
 analyticsInterest(broken.db,'broken',true);analyticsInterest(active.db,'active',true);const stop=startAnalyticsWarmer(()=>[broken,active,active] as any,()=>true,()=>failures++);
 await settle();assert.equal(failures,1);assert.equal(calls,1);t.mock.timers.tick(60000);await settle();assert.equal(calls,1);stop();release({preparing:true});await settle();t.mock.timers.tick(60000);await settle();assert.equal(calls,1);t.mock.timers.reset();
});
test('a browser lease moves between profiles, closes explicitly, expires and rejects invalid identifiers',()=>{
 const a={},b={};analyticsInterest(a,'browser',true,1000);assert.equal(analyticsViewed(a,1000),true);analyticsInterest(b,'browser',true,2000);assert.equal(analyticsViewed(a,2000),false);assert.equal(analyticsViewed(b,2000),true);analyticsInterest(b,'browser',false,3000);assert.equal(analyticsViewed(b,3000),false);analyticsInterest(a,'invalid viewer!',true,4000);assert.equal(analyticsViewed(a,4000),false);analyticsInterest(a,'expiry',true,5000);assert.equal(analyticsViewed(a,335001),false);
});
