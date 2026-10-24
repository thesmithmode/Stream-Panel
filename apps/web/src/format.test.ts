import test from 'node:test';
import assert from 'node:assert/strict';
import {num,pct,dateTime} from './format.ts';

test('Russian display formatting rounds shares and respects Moscow date boundaries', context=>{
 context.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-23T12:00:00Z')});
 assert.equal(num(8.92),'8,9');
 assert.equal(num(1000,0),'1 000');
 assert.equal(pct(.366),'37%');
 assert.equal(pct(.0456),'4,6%');
 assert.equal(pct(0),'0%');
 assert.equal(pct(1),'100%');
 assert.match(dateTime(Date.parse('2026-10-23T22:15:59Z')),/24 октября.*01:15/);
 assert.doesNotMatch(dateTime(Date.parse('2026-10-23T22:15:59Z')),/2026|:59/);
 assert.match(dateTime(Date.parse('2025-10-23T12:15:00Z')),/2025.*15:15/);
});
