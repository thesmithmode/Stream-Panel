import test from 'node:test';import assert from 'node:assert/strict';import {chartLayout,chartPages} from './chart-layout.ts';
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
