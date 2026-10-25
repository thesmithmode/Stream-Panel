import test from 'node:test';
import assert from 'node:assert/strict';
import {analyticsReport,useReport,type SharedReport} from './analytics-load.ts';
test('abandoned analytics progress stops before another request and completed results pass through',async()=>{
 const controller=new AbortController();let calls=0;
 await assert.rejects(analyticsReport(async()=>{calls++;controller.abort();return {preparing:true};},controller.signal),{name:'AbortError'});
 assert.equal(calls,1);
 const report=await analyticsReport(async()=>({preparing:++calls<4,value:42}),new AbortController().signal);
 assert.equal(report.value,42);assert.equal(calls,4);
});
test('one consumer cancels independently; cancelling the last consumer stops shared work',async()=>{
 let resolve!:(value:number)=>void;
 const entry:SharedReport<number>={controller:new AbortController(),pending:true,users:0,task:new Promise(r=>resolve=r)};
 const first=new AbortController(),second=new AbortController();
 const a=useReport(entry,first.signal),b=useReport(entry,second.signal);
 first.abort();await assert.rejects(a,{name:'AbortError'});assert.equal(entry.controller.signal.aborted,false);
 entry.pending=false;resolve(42);assert.equal(await b,42);assert.equal(entry.users,0);
 const abandoned:SharedReport<number>={controller:new AbortController(),pending:true,users:0,task:new Promise(()=>{})};
 const controller=new AbortController(),pending=useReport(abandoned,controller.signal);controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(abandoned.controller.signal.aborted,true);
});
test('an aborted caller does not subscribe and shared failures reach every waiter',async()=>{
 const controller=new AbortController();controller.abort();
 const entry:SharedReport<number>={controller:new AbortController(),pending:false,users:0,task:Promise.resolve(1)};
 await assert.rejects(useReport(entry,controller.signal),{name:'AbortError'});assert.equal(entry.users,0);
 entry.task=Promise.reject(new Error('fixture failure'));await assert.rejects(useReport(entry),/fixture failure/);assert.equal(entry.users,0);
});
