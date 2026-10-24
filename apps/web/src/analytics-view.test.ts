import test from 'node:test';
import assert from 'node:assert/strict';
import {analyticsView} from './analytics-view.ts';
test('display preferences validate every option and reset corrupt or incomplete storage',()=>{
 const defaults=analyticsView(null);
 assert.deepEqual(analyticsView({}),defaults);
 assert.deepEqual(analyticsView('broken'),defaults);
 const saved={metric:'messages',heatMetric:'viewers',sort:'attendanceRatio',resolution:30,showRegulars:false,regularOnly:true,coreOnly:true,report:false,trend:false,categories:false,hours:false,streams:false,audience:false};
 assert.deepEqual(analyticsView(saved),saved);
 assert.deepEqual(analyticsView(Object.fromEntries(Object.keys(saved).map(key=>[key,'invalid']))),defaults);
 assert.equal(analyticsView({resolution:0}).resolution,15);
 for(const resolution of [1,15,30,60])assert.equal(analyticsView({resolution}).resolution,resolution);
});

test('profiles retain separate display layout and audience filters, including legacy migration and corrupt storage',async()=>{
 const {loadAnalyticsView,saveAnalyticsView}=await import('./analytics-view.ts');const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
 values.set('sp-analytics-view-ruslan',JSON.stringify({streams:false,coreOnly:true}));values.set('sp-analytics-view-gulnaz',JSON.stringify({streams:true,coreOnly:false}));
 const a=loadAnalyticsView(()=>storage,'ruslan');saveAnalyticsView(()=>storage,'ruslan',a);const b=loadAnalyticsView(()=>storage,'gulnaz');assert.equal(b.streams,true);assert.equal(b.coreOnly,false);assert.equal(a.coreOnly,true);
 saveAnalyticsView(()=>storage,'gulnaz',{...b,hours:false,coreOnly:true,regularOnly:true});assert.equal(loadAnalyticsView(()=>storage,'ruslan').hours,true);assert.equal(loadAnalyticsView(()=>storage,'ruslan').regularOnly,false);assert.equal(loadAnalyticsView(()=>storage,'gulnaz').regularOnly,true);
 values.set('sp-analytics-view-ruslan','broken');assert.equal(loadAnalyticsView(()=>storage,'ruslan').hours,true);
 const denied={getItem:()=>{throw Error('denied');},setItem:()=>{throw Error('denied');}};assert.deepEqual(loadAnalyticsView(()=>denied,'ruslan'),analyticsView(null));saveAnalyticsView(()=>denied,'ruslan',a);
 assert.deepEqual(loadAnalyticsView(()=>{throw Error('getter denied');},'ruslan'),analyticsView(null));saveAnalyticsView(()=>{throw Error('getter denied');},'ruslan',a);
 values.clear();assert.deepEqual(loadAnalyticsView(()=>storage,'gulnaz'),analyticsView(null));
});
