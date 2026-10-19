import test from 'node:test';
import assert from 'node:assert/strict';
import {clockActivity,clockActivitySeries,mergeClockActivity,clockDonationSeries,clockAxis} from '../src/clock-activity.js';
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
 for(const step of [1,5,15,30,60])assert.equal(series(rows,'viewers',step).length,1440/step);
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
 const empty=clockActivitySeries(legacy,'youtubeMessages',99);
 assert.equal(empty.length,24);assert.ok(empty.every(b=>b.value===null));
 const point={at:base,twitchViewers:4,youtubeViewers:2,twitchMessages:2,youtubeMessages:1,viewers:6,messages:3};
 const rows=clockActivity([point],[{from:base,to:base+minute}],'Europe/Moscow');
 assert.equal(clockActivitySeries(rows,'twitchViewers',30).find(b=>b.minute===600)!.value,4);
 assert.equal(clockActivitySeries(rows,'youtubeMessages',30).find(b=>b.minute===600)!.value,60);
});


test('watch hours integrate only known samples while means remain independent of broadcast frequency',()=>{
 const points=[{at:base,viewers:3,twitchViewers:2,youtubeViewers:1},{at:base+minute,viewers:9,viewersPartial:true,twitchViewers:9}];
 const rows=clockActivity(points,[{from:base,to:base+minute*1.5}],'Europe/Moscow');
 const value=(metric:Parameters<typeof clockActivitySeries>[1],data=rows)=>clockActivitySeries(data,metric,60).find(b=>b.minute===600)!;
 assert.equal(value('viewers').value,3);
 assert.equal(value('watchHours').value,3/60);
 assert.equal(value('twitchWatchHours').value,6.5/60);
 assert.equal(value('youtubeWatchHours').value,1/60);
 const repeated=mergeClockActivity([...rows,...rows]);
 assert.equal(value('viewers',repeated).value,3);
 assert.equal(value('watchHours',repeated).value,6/60);
 assert.equal(value('watchHours').duration,minute);
 assert.equal(clockActivitySeries(rows,'watchHours',60,'weekends')[10]!.value,null);
});
test('donations are normalized by clipped airtime and zero is distinct from no broadcast',()=>{
 const rows=clockActivity([{at:base,donations:1},{at:base+minute}], [{from:base,to:base+1.5*minute}],'Europe/Moscow');
 const bucket=clockActivitySeries(rows,'donations',60).find(b=>b.minute===600)!;
 assert.equal(bucket.value,40);assert.equal(bucket.total,1);assert.equal(bucket.duration,1.5*minute);
 assert.equal(clockActivitySeries(rows,'donations',1).find(b=>b.minute===601)!.value,0);
 assert.equal(clockActivitySeries(rows,'donations',1)[0]!.value,null);
});


test('donation clock sums exact currency amounts and uses actual airtime instead of counts',()=>{
 const a=clockActivity([{at:base,donations:1,donationAmounts:{RUB:'10000',USD:'200'}}],[{from:base,to:base+minute}],'Europe/Moscow');
 const b=clockActivity([{at:base+86400000,donations:1,donationAmounts:{RUB:'20000',USD:'100'}}],[{from:base+86400000,to:base+86400000+minute/2}],'Europe/Moscow');
 const before=JSON.stringify([a,b]),rows=mergeClockActivity([...a,...b]);
 assert.equal(clockDonationSeries(rows,'RUB',60)[10]!.value,12000);
 assert.equal(clockDonationSeries(rows,'USD',60)[10]!.value,120);
 assert.equal(clockDonationSeries(rows,'EUR',60)[10]!.value,0);
 assert.equal(clockDonationSeries(rows,'RUB',60)[0]!.value,null);
 assert.ok(clockDonationSeries(rows,'RUB',60,'weekends').every(b=>b.value===null));
 assert.equal(clockDonationSeries(rows,'RUB',99).length,24);
 assert.equal(JSON.stringify([a,b]),before);
 rows[0]!.donationAmounts!.RUB='0';assert.equal(a[0]!.donationAmounts!.RUB,'10000');
});
test('numeric axis spans zero through the peak with readable intermediate levels',()=>{
 for(const peak of [0,.03,1,3,12,5000]){
  const levels=clockAxis(peak);assert.equal(levels[0],0);assert.ok(levels.at(-1)!>=peak);assert.ok(levels.length>=3&&levels.length<=6);
  assert.ok(levels.every((n,i)=>!i||n>levels[i-1]!));
 }
});

test('partial display pools only known minutes with a lower-bound marker and preserves exact statistics',()=>{
 const partial=clockActivity([{at:base,viewers:8,twitchViewers:8,youtubeViewers:null,viewersPartial:true},{at:base+minute,viewers:null}],[{from:base,to:base+2*minute}],'Europe/Moscow');
 const full=clockActivity([{at:base+7*86400000,viewers:2,twitchViewers:2,youtubeViewers:0}],[{from:base+7*86400000,to:base+7*86400000+minute/2}],'Europe/Moscow');
 const before=JSON.stringify([partial,full]),merged=mergeClockActivity([...partial,...full]);
 const result=clockActivitySeries(merged,'viewers',60,'пн',true)[10]!;
 assert.equal(result.value,6);assert.equal(result.duration,1.5*minute);assert.equal(result.partial,true);
 assert.equal(clockActivitySeries(merged,'viewers',60,'пн')[10]!.value,2);
 assert.equal(clockActivitySeries(merged,'watchHours',60,'пн',true)[10]!.value,9/60);
 assert.equal(clockActivitySeries(merged,'youtubeViewers',60,'пн',true)[10]!.value,0);
 assert.equal(clockActivitySeries(merged,'viewers',60,'вт',true)[10]!.value,null);
 assert.equal(JSON.stringify([partial,full]),before);
});
