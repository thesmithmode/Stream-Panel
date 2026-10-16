import test from 'node:test';
import assert from 'node:assert/strict';
import {clockActivity,clockActivitySeries,mergeClockActivity} from '../src/clock-activity.js';
const minute=60000,base=Date.UTC(2026,9,12,7); // 10:00 Moscow, Monday
const series=(rows:ReturnType<typeof clockActivity>,metric:'viewers'|'messages'='viewers',resolution=15,day='all')=>clockActivitySeries(rows,metric,resolution,day);
test('clock overlays dates, weights partial airtime, excludes missing/partial samples and retains true zero',()=>{
 const a=clockActivity([{at:base,viewers:2,messages:2},{at:base+minute,viewers:0,messages:0},{at:base+2*minute,viewers:99,viewersPartial:true,messages:1}], [{from:base,to:base+3*minute}],'Europe/Moscow');
 const b=clockActivity([{at:base+86400000,viewers:8,messages:2}],[{from:base+86400000,to:base+86400000+minute/2}],'Europe/Moscow');
 const rows=mergeClockActivity([...a,...b]),bucket=series(rows).find(b=>b.minute===600)!;
 assert.equal(bucket.value,2.4); // (2*60 + 0*60 + 8*30) / 150 seconds
 assert.ok(Math.abs(series(rows,'messages').find(b=>b.minute===600)!.value!-5*3600000/(3.5*minute))<1e-9);
 assert.equal(series(rows)[0]!.value,null);
 assert.equal(series(rows,'viewers',1).find(b=>b.minute===601)!.value,0);
 for(const step of [1,15,30,60])assert.equal(series(rows,'viewers',step).length,1440/step);
 assert.ok(series(rows,'viewers',60,'weekends').every(b=>b.value===null));
 assert.equal(series(rows,'viewers',15,'weekdays').find(b=>b.minute===600)!.value,2.4);
});
test('cached stream merging preserves sufficient statistics and does not mutate source reports',()=>{
 const row=clockActivity([{at:base,viewers:4}],[{from:base,to:base+minute}],'Europe/Moscow');
 const snapshot=JSON.stringify(row),merged=mergeClockActivity([...row,...row]);
 assert.equal(series(merged).find(b=>b.minute===600)!.value,4);assert.equal(JSON.stringify(row),snapshot);
 assert.equal(clockActivity([{at:base,viewers:4,isBreak:true}],[{from:base,to:base+minute}],'Europe/Moscow').length,0);
});

test('offline samples do not create exposure; unsupported saved steps and legacy empty counters are safe',()=>{
 assert.deepEqual(clockActivity([{at:base,viewers:8}],[],'Europe/Moscow'),[]);
 const legacy=[{day:'пн',minute:600,totals:[],durations:[]}];
 const empty=clockActivitySeries(legacy,'youtubeMessages',5);
 assert.equal(empty.length,24);assert.ok(empty.every(b=>b.value===null));
 const point={at:base,twitchViewers:4,youtubeViewers:2,twitchMessages:2,youtubeMessages:1,viewers:6,messages:3};
 const rows=clockActivity([point],[{from:base,to:base+minute}],'Europe/Moscow');
 assert.equal(clockActivitySeries(rows,'twitchViewers',30).find(b=>b.minute===600)!.value,4);
 assert.equal(clockActivitySeries(rows,'youtubeMessages',30).find(b=>b.minute===600)!.value,60);
});
