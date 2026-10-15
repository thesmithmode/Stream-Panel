import test from 'node:test';
import assert from 'node:assert/strict';
import {chartSeries} from './chart-series.ts';

test('regular segments use the same known-minute denominator as the full bar; messages remain sums',()=>{
 const points=[{at:0,observed:10,regularObserved:8,messages:5,regularMessages:4,presenceKnown:true},{at:60000,observed:10,regularObserved:2,messages:1,regularMessages:0,presenceKnown:true},{at:120000,observed:99,regularObserved:99,messages:7,regularMessages:7,presenceKnown:false},{at:480*60000,observed:0,messages:0,presenceKnown:true}];
 const first=chartSeries(points,'observed',5)[0]!;
 assert.equal(first.value,10);assert.equal(first.regularValue,5);assert.equal(first.known,true);
 const messages=chartSeries(points,'messages',5)[0]!;
 assert.equal(messages.value,13);assert.equal(messages.regularValue,11);
});

test('aggregate viewers have no personal split, zero is known, and unknown/empty samples never imply regulars',()=>{
 assert.deepEqual(chartSeries([],'observed'),[]);
 assert.equal(chartSeries([{at:0,viewers:null}], 'viewers')[0]?.known,false);
 const zero=chartSeries([{at:0,viewers:0,regularObserved:5}], 'viewers')[0]!;
 assert.equal(zero.known,true);assert.equal(zero.value,0);assert.equal(zero.regularValue,0);
 const unknown=chartSeries([{at:0,observed:10,regularObserved:5,presenceKnown:false}],'observed')[0]!;
 assert.equal(unknown.known,false);assert.equal(unknown.regularValue,0);
});

test('YouTube estimate segments remain bounded by the total and tolerate legacy samples without subgroup data',()=>{
 assert.equal(chartSeries([{at:0,estimated:4,regularEstimated:2}],'estimated')[0]?.regularValue,2);
 assert.equal(chartSeries([{at:0,estimated:4,regularEstimated:8}],'estimated')[0]?.regularValue,4);
 assert.equal(chartSeries([{at:0,estimated:4,regularEstimated:-2}],'estimated')[0]?.regularValue,0);
 assert.equal(chartSeries([{at:0,estimated:4}],'estimated')[0]?.regularValue,0);
});

test('known legacy sample without the selected metric contributes a zero instead of NaN',()=>{
 const [point]=chartSeries([{at:0,presenceKnown:true}],'observed');
 assert.deepEqual(point,{followerValue:0,at:0,known:true,isBreak:false,value:0,regularValue:0,width:60000});
});

 test('requested chart resolution aggregates accurately and caps long periods',()=>{
 const points=[{at:0,messages:2,regularMessages:1},{at:60000,messages:3,regularMessages:2}];
 assert.equal(chartSeries(points,'messages',5)[0]?.width,300000);
 assert.equal(chartSeries(points,'messages',5)[0]?.value,5);
 assert.equal(chartSeries(points,'messages',5)[0]?.regularValue,3);
 assert.equal(chartSeries(points,'messages',1).length,2);
 const long=Array.from({length:129600},(_,i)=>({at:i*60000,messages:1}));
 assert.ok(chartSeries(long,'messages',1).every(p=>p.width<=300000));
 assert.equal(chartSeries(points,'messages',NaN)[0]?.width,60000);
 });

test('break buckets exclude presence and messages and mixed live buckets retain live values',()=>{
 const points=[{at:0,isBreak:true,observed:99,messages:99,presenceKnown:false},{at:60000,observed:4,messages:2,presenceKnown:true}];
 assert.equal(chartSeries(points,'observed')[0]?.isBreak,true);
 assert.equal(chartSeries(points,'messages')[0]?.value,0);
 const mixed=chartSeries(points,'observed',5)[0]!;assert.equal(mixed.isBreak,false);assert.equal(mixed.value,4);
});


test('minute default and explicit 1/5/15 minute buckets preserve sums and separate platform averages',()=>{
 const points=[{at:0,twitchViewers:10,youtubeViewers:null,viewers:10,viewersPartial:true,messages:2},{at:60000,twitchViewers:2,youtubeViewers:4,viewers:6,messages:3}];
 assert.equal(chartSeries(points,'viewers').length,2);
 for(const resolution of [1,5,15]){
  const all=chartSeries(points,'viewers',resolution),tw=chartSeries(points,'twitchViewers',resolution),yt=chartSeries(points,'youtubeViewers',resolution);
  for(let i=0;i<all.length;i++)assert.equal(all[i]!.value,tw[i]!.value+yt[i]!.value);
  assert.equal(all[0]!.width,resolution*60000);
 }
 assert.equal(chartSeries(points,'viewers',5)[0]!.partial,true);
 assert.equal(chartSeries(points,'messages',15)[0]!.value,5);
});

test('platform message charts sum counts and disjoint groups at all supported resolutions',()=>{
 const points=[{at:0,messages:12,twitchMessages:9,youtubeMessages:3,regularMessages:3,regularTwitchMessages:2,regularYoutubeMessages:1,followerMessages:4,followerTwitchMessages:3,followerYoutubeMessages:1,unknownMessages:1,unknownTwitchMessages:0,unknownYoutubeMessages:1},{at:60000,messages:2,twitchMessages:1,youtubeMessages:1,regularMessages:0,regularTwitchMessages:0,regularYoutubeMessages:0,followerMessages:0,followerTwitchMessages:0,followerYoutubeMessages:0,unknownMessages:2,unknownTwitchMessages:1,unknownYoutubeMessages:1}];
 for(const resolution of [1,5,15]){
  const all=chartSeries(points,'messages',resolution),tw=chartSeries(points,'twitchMessages',resolution),yt=chartSeries(points,'youtubeMessages',resolution);
  for(let i=0;i<all.length;i++)for(const key of ['value','regularValue','followerValue','unknownValue'] as const)assert.equal(all[i]![key],tw[i]![key]!+yt[i]![key]!);
 }
});

test('daily means retain local midnight instead of shifting the selected calendar day to UTC',()=>{
 const at=Date.UTC(2026,9,1,21),points=[{at,messages:5,viewers:2,presenceKnown:true},{at:at+86400000,messages:7,viewers:4,presenceKnown:true}];
 assert.equal(chartSeries(points,'messages',1440)[0]?.at,at);assert.equal(chartSeries(points,'messages',1440)[0]?.value,5);assert.equal(chartSeries(points,'viewers',1440)[1]?.value,4);
});
