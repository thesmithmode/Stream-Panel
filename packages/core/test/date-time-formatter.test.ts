import test from 'node:test';import assert from 'node:assert/strict';
import {dateTimeFormatter} from '../src/date-time-formatter.js';
test('shared native formatters preserve exact timezone, locale, DST and option semantics',()=>{
 for(const locale of ['ru-RU','en-GB','sv-SE'])for(const timeZone of ['Europe/Moscow','America/New_York','Asia/Kolkata']){
  const options:Intl.DateTimeFormatOptions={timeZone,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'};
  const cached=dateTimeFormatter(locale,options),fresh=new Intl.DateTimeFormat(locale,options);
  assert.equal(dateTimeFormatter(locale,Object.fromEntries(Object.entries(options).reverse())),cached);
  for(const at of [Date.UTC(2026,2,8,6,59),Date.UTC(2026,2,8,7),Date.UTC(2026,10,1,5,59),Date.UTC(2026,10,1,6)])assert.deepEqual(cached.formatToParts(at),fresh.formatToParts(at));
 }
 assert.throws(()=>dateTimeFormatter('ru-RU',{timeZone:'invalid/timezone'}),RangeError);
 const early=dateTimeFormatter('en-GB',{timeZone:'UTC',year:'numeric'});
 for(const timeZone of ['UTC','Europe/London','Europe/Berlin','Asia/Tokyo','America/Chicago'])for(const month of ['numeric','2-digit','short','long','narrow'] as const)for(const weekday of ['short','long'] as const)dateTimeFormatter('en-GB',{timeZone,month,weekday});
 assert.equal(dateTimeFormatter('en-GB',{timeZone:'UTC',year:'numeric'}).format(0),early.format(0));
 assert.notEqual(dateTimeFormatter('en-GB',{timeZone:'UTC',year:'numeric'}),early,'old native objects are evicted');
});
