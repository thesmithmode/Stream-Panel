import test from 'node:test';import assert from 'node:assert/strict';import {chartLayout,chartPages,countAxis} from './chart-layout.ts';
test('phone and desktop honor the chosen 1/5/15 minute interval without automatic aggregation',()=>{
 for(const resolution of [1,5,15]){
  assert.equal(chartLayout(0,180*60000,340,resolution).resolution,resolution);
  assert.equal(chartLayout(0,180*60000,1200,resolution).resolution,resolution);
 }
 assert.equal(chartLayout(0,60000,340,0).resolution,1);
 assert.equal(chartLayout(0,60000,0,NaN).resolution,1);
 assert.equal(chartLayout(0,60000,340,1).plotWidth,340);
});

test('chart pages omit multi-day gaps and preserve every point with at most six hours per page',()=>{
 const points=[...Array.from({length:400},(_,i)=>({at:i*60000})),...Array.from({length:20},(_,i)=>({at:3*86400000+i*60000}))];
 const pages=chartPages(points);assert.equal(pages.length,3);assert.equal(pages[0]!.length,20);assert.deepEqual(pages.toReversed().flat(),points);assert.deepEqual(chartPages([]),[]);
 for(const page of pages)assert.ok(page.at(-1)!.at-page[0]!.at<360*60000);
});

test('count axes use integer intermediate ticks and round nine up to ten without changing values',()=>{
 assert.deepEqual(countAxis(9),{maximum:10,ticks:[0,2,4,6,8,10]});
 assert.deepEqual(countAxis(4.69),{maximum:5,ticks:[0,1,2,3,4,5]});
 for(const value of [0,1,.28,11,100,999,1000000,NaN,Infinity]){const axis=countAxis(value);assert.ok(axis.maximum>=Math.max(1,Number.isFinite(value)?value:0));assert.ok(axis.ticks.length>=2&&axis.ticks.length<=6);assert.ok(axis.ticks.every(Number.isInteger));}
});
