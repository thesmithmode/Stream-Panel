import test from 'node:test';
import assert from 'node:assert/strict';
import {streamRange} from './stream-time.ts';
test('stream dates always use Moscow and cross a date boundary correctly',()=>{
 assert.equal(streamRange(Date.parse('2026-09-13T08:04Z'),Date.parse('2026-09-13T11:55Z')),'2026-09-13 11:04 — 2026-09-13 14:55');
 assert.equal(streamRange(Date.parse('2026-09-13T22:04Z'),null),'2026-09-14 01:04 — в эфире');
});
