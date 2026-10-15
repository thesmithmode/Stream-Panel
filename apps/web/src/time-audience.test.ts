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
 assert.equal(platformClass('twitch,donationalerts'),'twitch');assert.equal(platformClass(['youtube']),'youtube');assert.equal(platformClass('twitch,youtube'),'');assert.equal(platformClass('donationalerts'),'');assert.equal(platformClass(null),'');assert.equal(platformClass(undefined),'');
});
test('hour means stay equal when one hour has many more broadcasts and rotating people',()=>{
 const windows: {session:string;from:number;to:number}[]=[],people:any[]=[];
 for(let i=0;i<11;i++){
  const from=base+i*86400000+(i?8*hour:0),window={session:String(i),from,to:from+hour};windows.push(window);
  for(let j=0;j<2;j++)people.push({id:`person-${i}-${j}`,name:'Viewer',intervals:[window]});
 }
 const result=timeAudience(windows,people,'UTC');
 const morning=result.find(b=>b.minute===10*60)!,evening=result.find(b=>b.minute===18*60)!;
 assert.equal(morning.averageAudience,2);assert.equal(evening.averageAudience,2);
 assert.equal(morning.streams.size,1);assert.equal(evening.streams.size,10);assert.equal(evening.people.size,20);
 assert.equal(result.find(b=>b.minute===0)!.averageAudience,null,'no airtime is not a zero audience');
});
test('means weight partial broadcasts by exact duration and union overlapping platform/message signals',()=>{
 const window={session:'full',from:base+15*1000,to:base+30*m+15*1000};
 const short={session:'short',from:base+86400000,to:base+86400000+10*m};
 const people=[{id:'a',name:'A',intervals:[window,{...window}],messageMinutes:[{session:'full',at:base+m},{session:'full',at:base+m}]},...Array.from({length:4},(_,i)=>({id:`short-${i}`,name:'S',intervals:[short]}))];
 const windows=[window,{...window,from:base+m,to:base+2*m},short];
 const before=structuredClone({windows,people}),bucket=timeAudience(windows,people,'UTC').find(b=>b.minute===10*60)!;
 assert.equal(bucket.airtimeMs,40*m);assert.equal(bucket.personTimeMs,70*m);assert.equal(bucket.averageAudience,1.75);
 assert.equal(bucket.people.get('a')!.size,1);assert.deepEqual({windows,people},before,'calculations never mutate API data');
 const fractional=timeAudience([{session:'x',from:base,to:base+m}],[{id:'x',name:'X',intervals:[{session:'x',from:base+15*1000,to:base+30*1000}]}],'UTC',1,'all',10)[0]!;
 assert.equal(fractional.averageAudience,.25);
});
test('weekday/weekend groups follow the configured local date, including Friday midnight',()=>{
 const from=Date.UTC(2026,9,9,20,30),window={session:'friday-saturday',from,to:from+hour};
 const weekday=timeAudience([window],[{id:'p',name:'P',intervals:[window]}],'Europe/Moscow',60,'weekdays');
 const weekend=timeAudience([window],[{id:'p',name:'P',intervals:[window]}],'Europe/Moscow',60,'weekends');
 assert.equal(weekday.find(b=>b.minute===23*60)!.airtimeMs,30*m);assert.equal(weekday[0]!.averageAudience,null);
 assert.equal(weekend[0]!.airtimeMs,30*m);assert.equal(weekend[0]!.averageAudience,1);assert.equal(weekend.find(b=>b.minute===23*60)!.averageAudience,null);
 const utcWeekend=timeAudience([window],[],'UTC',60,'weekends');assert.ok(utcWeekend.every(b=>b.averageAudience===null));
});

import {localDateWindow} from './time-audience.ts';
test('calendar-day drill-down respects timezone and daylight saving boundaries',()=>{
 assert.equal(localDateWindow('2026-03-29','Europe/Berlin').to-localDateWindow('2026-03-29','Europe/Berlin').from,23*hour);
 assert.equal(localDateWindow('2026-10-25','Europe/Berlin').to-localDateWindow('2026-10-25','Europe/Berlin').from,25*hour);
 assert.equal(localDateWindow('2026-10-01','Europe/Moscow').from,Date.UTC(2026,8,30,21));
 assert.throws(()=>localDateWindow('2026-02-30','UTC'),/INVALID_DATE/);assert.throws(()=>localDateWindow('invalid','UTC'),/INVALID_DATE/);
});
