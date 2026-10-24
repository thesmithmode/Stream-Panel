import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyMetrics,streamRecords,type StreamMetric} from './daily-metrics.ts';
const at=Date.UTC(2026,9,20,20),minute=60000;
const streams:StreamMetric[]=[
 {id:'first',startedAt:at,durationMs:minute,meanChatters:2,messages:5,viewers:{known:{mean:4,knownMinutes:1,partialMinutes:1},twitch:{mean:4,knownMinutes:1}}},
 {id:'second',startedAt:at+minute,durationMs:3*minute,meanChatters:0,messages:12,viewers:{known:{mean:8,knownMinutes:3},youtube:{mean:8,knownMinutes:3}}},
 {id:'unknown',startedAt:at+86400000,durationMs:minute,meanChatters:null,messages:0},
];
test('daily means weight measured viewer minutes and broadcast duration, preserving zero and missing values',()=>{
 const rows=dailyMetrics([...streams].reverse(),'Europe/Moscow');
 assert.equal(rows.length,2);assert.equal(rows[0]!.date,'2026-10-20');assert.equal(rows[0]!.online,7);assert.equal(rows[0]!.active,255);assert.equal(rows[0]!.partial,true);assert.equal(rows[1]!.online,null);assert.equal(rows[1]!.active,0);
 assert.equal(dailyMetrics(streams,'Europe/Moscow','twitch')[0]!.online,4);assert.equal(dailyMetrics(streams,'Europe/Moscow','youtube')[0]!.online,8);
 assert.equal(dailyMetrics([{startedAt:at,endedAt:at+minute,viewers:{all:{mean:0}}}],'UTC')[0]!.online,0);
 assert.deepEqual(dailyMetrics([],'UTC'),[]);
});
test('date buckets follow the chosen timezone and a record date belongs to its broadcast, with earliest ties',()=>{
 const midnight=Date.UTC(2026,9,20,22);
 assert.equal(dailyMetrics([{startedAt:midnight}],'Europe/Moscow')[0]!.date,'2026-10-21');
 assert.equal(dailyMetrics([{startedAt:midnight}],'UTC')[0]!.date,'2026-10-20');
 const records=streamRecords([...streams,{...streams[1]!,id:'tie',startedAt:at+86400000}]);
 assert.deepEqual(records.online,{value:8,at:at+minute});assert.deepEqual(records.messages,{value:12,at:at+minute});assert.deepEqual(streamRecords([{startedAt:0}]),{online:null,messages:null});
});
