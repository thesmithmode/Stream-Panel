import test from 'node:test';import assert from 'node:assert/strict';
import {subscriberSteps,stepPath,subscriberPath,subscriberValueAt} from './subscriber-chart.ts';
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
