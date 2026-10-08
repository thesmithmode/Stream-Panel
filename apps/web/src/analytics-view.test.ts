import test from 'node:test';
import assert from 'node:assert/strict';
import {analyticsView} from './analytics-view.ts';
test('display preferences validate every option and reset corrupt or incomplete storage',()=>{
 const defaults=analyticsView(null);
 assert.deepEqual(analyticsView({}),defaults);
 assert.deepEqual(analyticsView('broken'),defaults);
 const saved={metric:'messages',heatMetric:'viewers',sort:'attendanceRatio',resolution:15,hourView:'table',showRegulars:false,regularOnly:true,coreOnly:true,report:false,trend:false,categories:false,hours:false,streams:false,audience:false};
 assert.deepEqual(analyticsView(saved),saved);
 assert.deepEqual(analyticsView(Object.fromEntries(Object.keys(saved).map(key=>[key,'invalid']))),defaults);
 for(const resolution of [0,1,5,15,60,1440])assert.equal(analyticsView({resolution}).resolution,resolution);
});
