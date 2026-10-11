import test from 'node:test';import assert from 'node:assert/strict';import {sessionGroup} from './session-group.ts';
test('stream groups follow Moscow calendar days and Monday week boundary',()=>{
 const now=Date.UTC(2026,9,11,21,30);assert.equal(sessionGroup(Date.UTC(2026,9,11,21,1),now),'Сегодня');assert.equal(sessionGroup(Date.UTC(2026,9,11,20),now),'Вчера');assert.equal(sessionGroup(Date.UTC(2026,9,10,12),now),'На прошлой неделе');assert.match(sessionGroup(Date.UTC(2026,7,1),now),/август/);
});
