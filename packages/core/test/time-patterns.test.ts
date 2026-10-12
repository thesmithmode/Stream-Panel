import test from 'node:test';import assert from 'node:assert/strict';
import {timePatterns} from '../src/time-patterns.js';
test('time patterns combine durations and currencies without averaging averages or inventing untested hours',()=>{
 const cell=(day:string,hour:number,minutes:number,viewers:number,messages:number,amount:string)=>({day,hour,sampleMinutes:minutes,observedKnownMinutes:minutes,observed:minutes*2,estimated:minutes,messages,viewersTotal:viewers*minutes,viewerSamples:minutes,donationTotals:{RUB:amount},donationCount:1});
 const data=timePatterns([cell('пн',13,30,10,20,'100'),cell('вт',13,90,2,10,'900'),cell('пн',14,0,0,0,'0')]);
 const hour=data.byHour.find(h=>h.hour===13)!;assert.equal(hour.viewerMean,4);assert.equal(hour.messagesPerHour,15);assert.equal(hour.donationTotals.RUB,'1000');assert.equal(hour.donationsPerHourMinor.RUB,'500');assert.equal(hour.observedMean,2);
 assert.equal(data.byHour.find(h=>h.hour===4),undefined);assert.equal(data.byWeekday.find(h=>h.day==='пн')!.sampleMinutes,30);assert.equal(data.byHour.find(h=>h.hour===14)!.viewerMean,null);
 assert.deepEqual(timePatterns([]),{byHour:[],byWeekday:[]});
});
