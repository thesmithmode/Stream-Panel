import test from 'node:test';import assert from 'node:assert/strict';import {timeAudience,clockLabel} from './time-audience.ts';import {periodRange,platformClass} from './period.ts';
const base=Date.UTC(2026,9,5,10),hour=3600000,m=60000;
test('time attendance divides by distinct streams that actually overlapped the selected time, including messages, breaks and linked signals',()=>{
 const windows=Array.from({length:20},(_,i)=>({session:String(i),from:base+i*86400000+(i>=10?hour:0),to:base+i*86400000+(i>=10?hour:0)+hour}));
 const people=[{id:'a',name:'A',intervals:windows.slice(0,10)},{id:'b',name:'B',intervals:[],messageMinutes:[{session:'0',at:base+30*m},{session:'0',at:base+30*m}]},{id:'outside',name:'Outside',intervals:[{session:'0',from:base-hour,to:base}]}];
 const result=timeAudience(windows,people),thirteen=result.find(b=>b.minute===13*60)!;assert.equal(thirteen.streams.size,10);assert.equal(thirteen.people.get('a')!.size,10);assert.equal(thirteen.people.get('b')!.size,1);assert.equal(thirteen.people.has('outside'),false);assert.equal(result.find(b=>b.minute===14*60)!.streams.size,10);
 const minute=timeAudience(windows,people,'Europe/Moscow',1,'all',13).find(b=>b.minute===13*60+30)!;assert.equal(minute.people.get('b')!.size,1);assert.equal(minute.streams.size,10);
 assert.equal(timeAudience(windows,people,'Europe/Moscow',5,'пн',13)[0]!.streams.size,2);
 assert.equal(timeAudience([],[],'UTC',99).length,24);assert.equal(clockLabel(13*60+5),'13:05');
});
test('time buckets cross local midnight, deduplicate overlapping stream segments, and omit gaps',()=>{
 const from=Date.UTC(2026,9,5,20,55),windows=[{session:'x',from,to:from+10*m},{session:'x',from:from+2*m,to:from+4*m}];
 const points=timeAudience(windows,[{id:'p',name:'P',intervals:windows}],'Europe/Moscow',5);
 assert.equal(points.find(p=>p.minute===23*60+55)!.streams.size,1);assert.equal(points.find(p=>p.minute===0)!.people.get('p')!.size,1);assert.equal(points.find(p=>p.minute===5)!.streams.size,0);
 const filtered=timeAudience(windows,[],'Europe/Moscow',1,'вт',0);assert.equal(filtered[0]!.streams.size,1);assert.equal(filtered[5]!.streams.size,0);
});
test('periods and platform labels are reused consistently and do not guess a platform for linked accounts',()=>{
 assert.deepEqual(periodRange(7,20*86400000),{from:13*86400000,to:20*86400000});assert.equal(periodRange('all',100).from,0);assert.equal(periodRange('custom',100).from,0);
 assert.equal(platformClass('twitch,donationalerts'),'twitch');assert.equal(platformClass(['youtube']),'youtube');assert.equal(platformClass('twitch,youtube'),'');assert.equal(platformClass('donationalerts'),'');
});
