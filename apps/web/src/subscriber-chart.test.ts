import test from 'node:test';import assert from 'node:assert/strict';
import {subscriberSteps,stepPath,subscriberPath,subscriberValueAt,subscriberStreamBands,subscriberScale,subscriberDateOffsets} from './subscriber-chart.ts';
test('Twitch steps use reconciled provider time, YouTube retains observation time and count corrections are not invented',()=>{
 const counts=[{at:0,total:10},{at:900,total:12}],follows=[{id:'a',name:'A',at:200},{id:'b',name:'B',at:700}];
 assert.deepEqual(subscriberSteps(counts,follows,'twitch',0),[{at:0,total:10},{at:200,total:11},{at:700,total:12},{at:900,total:12}]);
 assert.deepEqual(subscriberSteps(counts,follows,'youtube',0),counts);assert.deepEqual(subscriberSteps([{at:0,total:10},{at:900,total:9}],follows,'twitch',100),[{at:100,total:10},{at:900,total:9}]);assert.equal(stepPath(counts,n=>n,n=>n),'M0,10 H900V12');assert.equal(stepPath([],n=>n,n=>n),'');
});
test('a carried midnight count draws a visible line, without inventing earlier history',()=>{
 const points=subscriberSteps([{at:90,total:29}],[],'youtube',100);
 assert.deepEqual(points,[{at:100,total:29}]);
 assert.equal(subscriberPath(points,200,n=>n,n=>n),'M100,29 H200');
 assert.equal(subscriberValueAt(points,99),null);
 assert.equal(subscriberValueAt(points,100),29);
 assert.equal(subscriberValueAt([{at:100,total:29},{at:150,total:30}],149),29);
 assert.equal(subscriberValueAt([{at:100,total:29},{at:150,total:30}],150),30);
 assert.equal(subscriberPath([],200,n=>n,n=>n),'');
 assert.equal(subscriberPath(points,100,n=>n,n=>n),'M100,29');
});

test('stream bands preserve exclusive platform time, merge overlaps neutrally and clip the window',()=>{
 assert.deepEqual(subscriberStreamBands([{id:'a',start:0,end:100}],[{id:'b',start:20,end:80}],10,90),[
 {id:'a',start:10,end:20,source:'twitch'},{id:'a',start:20,end:80,source:'both'},{id:'a',start:80,end:90,source:'twitch'}]);
 assert.deepEqual(subscriberStreamBands([],[{id:'b',start:5,end:8}],0,10),[{id:'b',start:5,end:8,source:'youtube'}]);
 assert.deepEqual(subscriberStreamBands([{id:'a',start:0,end:3}],[{id:'b',start:5,end:8}],0,10),[{id:'a',start:0,end:3,source:'twitch'},{id:'b',start:5,end:8,source:'youtube'}]);
 assert.deepEqual(subscriberStreamBands([],[],0,10),[]);
 assert.deepEqual(subscriberStreamBands([{id:'a',start:0,end:10},{id:'a',start:2,end:8}],[],0,10),[{id:'a',start:0,end:10,source:'twitch'}]);
});

test('independent count axes retain integer ticks and cover empty, flat, zero and large counts',()=>{
 assert.deepEqual(subscriberScale([]),{low:0,high:1,ticks:[]});
 for(const values of [[29],[0],[51,52,56],[10000,12000]]){
  const scale=subscriberScale(values.map((total,at)=>({at,total})));
  assert.ok(scale.low>=0&&scale.high>scale.low);assert.ok(scale.low<=Math.min(...values)&&scale.high>=Math.max(...values));
  assert.ok(scale.ticks.length>=2&&scale.ticks.length<=6);assert.ok(scale.ticks.every(Number.isInteger));
 }
 assert.notDeepEqual(subscriberScale([{at:0,total:29}]),subscriberScale([{at:0,total:56}]));
 assert.deepEqual(subscriberDateOffsets(7),[0,1,2,3,4,5,6]);
 assert.deepEqual(subscriberDateOffsets(30),[0,5,10,15,20,25,29]);
});
