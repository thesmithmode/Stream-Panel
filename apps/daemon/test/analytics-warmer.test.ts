import test from 'node:test';import assert from 'node:assert/strict';
import {startAnalyticsWarmer} from '../src/analytics-warmer.js';
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const changes=(revision:number)=>({versions:{activity:revision,people:0,donations:0,follows:0}});
test('both profiles warm after restart while collection and visible requests take priority',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0,pending=1;
 const runtime={configuration:{value:{excludedBotLogins:[]}},db:{queueStatus:()=>({pending}),call:async(method:string)=>method==='changes'?changes(1):method==='advanceAnalytics'?{pending:0}:(calls++,{preparing:false})}};
 const stop=startAnalyticsWarmer(()=>[runtime] as any,()=>true,()=>{});
 try{await settle();assert.equal(calls,0);t.mock.timers.tick(250);await settle();assert.equal(calls,0);pending=0;t.mock.timers.tick(250);await settle();assert.equal(calls,1);}finally{stop();t.mock.timers.reset();}
});
test('warming finishes serially and leaves unchanged facts alone until a new revision',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0,failures=0,enabled=false,revision=1;
 const runtime={configuration:{value:{excludedBotLogins:[],youtubeAccountId:'yt'}},db:{call:async(method:string)=>method==='changes'?changes(revision):method==='advanceAnalytics'?{pending:0}:({preparing:++calls===1})}} as any;
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
