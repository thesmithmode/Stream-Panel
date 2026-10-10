import test from 'node:test';import assert from 'node:assert/strict';import {chartLayout} from './chart-layout.ts';
test('a multi-hour chart fits a phone without losing minute drilldown and respects explicit wider buckets',()=>{
 const mobile=chartLayout(0,180*60000,340,1),desktop=chartLayout(0,180*60000,1200,1);
 assert.ok(mobile.resolution>desktop.resolution);assert.ok(180/mobile.resolution<=29);assert.equal(mobile.plotWidth,340);
 assert.equal(chartLayout(0,60000,340,15).resolution,15);assert.equal(chartLayout(0,60000,0,NaN).resolution,1);
});
