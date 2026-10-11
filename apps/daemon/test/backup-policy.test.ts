import test from 'node:test';
import assert from 'node:assert/strict';
import {retainedBackups,backupDue,backupTimestamp} from '../src/backup-policy.js';
const day=86400000,now=Date.parse('2026-10-12T15:00:00Z');
const name=(at:number)=>`stream-panel-${new Date(at).toISOString().replace(/[:.]/g,'-')}-1234abcd.spbk`;
test('retention keeps one most recent copy per Moscow day and three older weekly points',()=>{
 const files=Array.from({length:64},(_,i)=>name(now-i*12*3600000));
 const retained=retainedBackups(files,now);
 assert.deepEqual([...retained].sort(),[0,1,2,3,4,5,6,7,14,21].map(d=>name(now-d*day)).sort());
 assert.equal(retained.size,10);
});
test('retention uses Moscow midnight, fills sparse older weeks, and preserves future-dated copies',()=>{
 const edge=Date.parse('2026-10-11T21:30:00Z');
 const files=[name(edge),name(edge-3600000),name(edge-8*day),name(edge-13*day),name(edge-19*day),name(edge-29*day),name(edge-30*day),name(edge+day),'unrelated.spbk'];
 const retained=retainedBackups(files,edge);
 assert.deepEqual([...retained].sort(),[files[0],files[1],files[2],files[4],files[5],files[7]].sort());
 assert.equal(backupTimestamp('bad'),null);
});
test('scheduled backups are due after twelve hours, on first startup and after a backwards clock jump',()=>{
 assert.equal(backupDue(0,now),true);
 assert.equal(backupDue(now-12*3600000+1,now),false);
 assert.equal(backupDue(now-12*3600000,now),true);
 assert.equal(backupDue(now+1,now),true);
});
test('retention preserves the current verified snapshot when timestamps tie',()=>{
 const first=name(now),second=first.replace('1234abcd','ffffffff');
 assert.deepEqual([...retainedBackups([second,first],now,first)],[first]);
 assert.deepEqual([...retainedBackups([first,second],now,first)],[first]);
 assert.equal(backupTimestamp('stream-panel-2026-99-99T99-99-99-000Z-1234abcd.spbk'),null);
});
