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
