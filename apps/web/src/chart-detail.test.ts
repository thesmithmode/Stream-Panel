import test from 'node:test';
import assert from 'node:assert/strict';
import {participantsAt, timelineTicks} from './chart-detail.ts';
test('bar participants use half-open evidence intervals, preserve source and deduplicate merged signals', () => {
 const people=[{id:'a',name:'A',core:true,intervals:[{from:0,to:60000,kind:'observed'},{from:30000,to:90000,kind:'chat_proxy'}]},{id:'b',name:'B',intervals:[{from:60000,to:120000,kind:'observed'}]},{id:'c',name:'C',intervals:[]}];
 assert.deepEqual(participantsAt(people,0,60000),[{id:'a',name:'A',core:true,observed:true,estimated:true}]);
 assert.deepEqual(participantsAt(people,90000,120000).map(p=>p.id),['b']);
 assert.deepEqual(participantsAt(people,120000,180000),[]);
});
test('stream timeline aligns to quarter hours, includes missing-data periods and bounds long ranges', () => {
 assert.deepEqual(timelineTicks(7*60000,61*60000),[15,30,45,60].map(m=>m*60000));
 assert.equal(timelineTicks(0,24*3600000).length,96);
 assert.ok(timelineTicks(0,365*86400000).length<=96);
 assert.deepEqual(timelineTicks(10,10),[]);
 assert.deepEqual(timelineTicks(NaN,10),[]);
});
