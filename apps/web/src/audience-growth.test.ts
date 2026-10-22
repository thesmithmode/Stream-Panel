import test from 'node:test';
import assert from 'node:assert/strict';
import {audienceGrowth,growthPath,type GrowthStream} from './audience-growth.ts';
const day=86400000;
const streams:GrowthStream[]=Array.from({length:40},(_,i)=>({id:String(i),startedAt:i*day,viewers:{all:{mean:i},twitch:{mean:i/2}}}));
test('trailing 7 and 30 day means are chronological, causal and exclude the expired boundary',()=>{
 const rows=audienceGrowth([...streams].reverse(),'all');
 assert.equal(rows[0]!.trend,0);assert.equal(rows[6]!.trend,3);assert.equal(rows[7]!.trend,4);
 assert.equal(rows[39]!.trend,36);assert.equal(rows[39]!.trend30,24.5);
 assert.equal(audienceGrowth(streams,'twitch')[7]!.trend,2);
 assert.equal(streams[0]!.id,'0');
});
test('missing streams remain unknown but never interrupt or dilute known averages',()=>{
 const rows=audienceGrowth(streams.map((s,i)=>i===3?{...s,viewers:{all:{mean:null}}}:s),'all');
 assert.equal(rows[3]!.value,null);assert.equal(rows[3]!.trend,1);
 assert.equal(rows[6]!.trend,3);assert.equal(rows[6]!.trendWindow,6);
 assert.equal(rows[7]!.trend,25/6);
 assert.equal(rows[39]!.trend30,24.5);
 assert.deepEqual(audienceGrowth([],'all'),[]);
 assert.equal(audienceGrowth([{startedAt:0}],'all')[0]!.trend,null);
});
test('sparse streams use calendar windows, keep measured zeros and do not include future streams',()=>{
 const rows=audienceGrowth([{startedAt:0,viewers:{all:{mean:10}}},{startedAt:10*day,viewers:{all:{mean:0}}},{startedAt:11*day}],'all');
 assert.equal(rows[1]!.trend,0);assert.equal(rows[1]!.trend30,5);
 assert.equal(rows[2]!.trend,0);assert.equal(rows[2]!.id,undefined);
});
test('smooth paths connect across unknown points with bounded controls and no invented points',()=>{
 assert.equal(growthPath([]),'');assert.equal(growthPath([{x:0,y:null}]),'');
 assert.equal(growthPath([{x:0,y:10},{x:10,y:null},{x:20,y:30},{x:30,y:0}]),'M0,10 C10,10 10,30 20,30 C25,30 25,0 30,0');
});
