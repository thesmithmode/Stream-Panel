import test from 'node:test';
import assert from 'node:assert/strict';
import {audienceGrowth,type GrowthStream} from './audience-growth.ts';
const streams:GrowthStream[]=Array.from({length:9},(_,i)=>({id:String(i),startedAt:i*86400000,categories:['Game'],viewers:{all:{mean:i},twitch:{mean:i/2},youtube:{mean:i/2}}}));
test('growth sorts streams and uses seven consecutive broadcasts without future values',()=>{
 const result=audienceGrowth([...streams].reverse(),'all');
 assert.equal(result[0]!.id,'0');assert.equal(result[5]!.trend,null);assert.equal(result[6]!.trend,3);assert.equal(result[7]!.trend,4);assert.equal(result[8]!.trend,5);
 assert.equal(audienceGrowth(streams,'twitch')[6]!.trend,1.5);
 assert.equal(audienceGrowth(streams,'youtube')[6]!.trend,1.5);
 assert.equal(streams[0]!.id,'0');
});
test('missing measurements leave gaps instead of zero or a shorter rolling window',()=>{
 const input=streams.map((s,i)=>i===3?{...s,viewers:{all:{mean:null}}}:s);
 const result=audienceGrowth(input,'all');assert.equal(result[3]!.value,null);assert.equal(result[6]!.trend,null);assert.equal(result[8]!.trend,null);
 assert.deepEqual(audienceGrowth([],'all'),[]);assert.equal(audienceGrowth([{id:'x',startedAt:0}],'all')[0]!.value,null);
});

test('legacy snapshots without stream identifiers remain renderable and do not invent links',()=>{
 const rows=audienceGrowth([{startedAt:1,viewers:{all:{mean:null}}},{startedAt:1,viewers:{all:{mean:4}}}],'all');
 assert.equal(rows.length,2);assert.equal(rows[0]!.id,undefined);assert.equal(rows[1]!.value,4);
});

test('a missing stream explains the seven-stream gap and trend returns only after seven measured broadcasts',()=>{
 const input=Array.from({length:15},(_,i)=>({id:String(i),startedAt:i,viewers:{all:{mean:i===6?null:4.4}}}));
 const rows=audienceGrowth(input,'all');assert.equal(rows[5]!.trendWindow,6);assert.equal(rows[5]!.trendMissing,0);
 assert.equal(rows[8]!.trendMissing,1);assert.equal(rows[8]!.trendWindow,7);assert.equal(rows[8]!.trend,null);
 assert.equal(rows[12]!.trend,null);assert.equal(rows[13]!.trendMissing,0);assert.ok(Math.abs(rows[13]!.trend!-4.4)<1e-10);
});
