import test from 'node:test';
import assert from 'node:assert/strict';
import {groupCollectionGaps, gapReasonLabel} from './collection-gaps.ts';

test('repeated collection failures share a display group but preserve disjoint and unknown intervals', () => {
  const gaps = [
    {id:'first',source:'twitch',reason:'connection_lost_no_replay',started_at_ms:100,ended_at_ms:200},
    {id:'next',source:'twitch',reason:'connection_lost_no_replay',started_at_ms:400,ended_at_ms:450},
    {id:'unknown',source:'twitch',reason:'connection_lost_no_replay',started_at_ms:600,ended_at_ms:null},
    {source:'youtube',reason:'connection_lost_no_replay',started_at_ms:300,ended_at_ms:350},
    {source:'twitch',reason:'chatters_poll_failed',started_at_ms:500,ended_at_ms:550},
  ];
  const before=structuredClone(gaps), groups=groupCollectionGaps(gaps);
  assert.equal(groups.length,3);
  assert.deepEqual(groups[0].intervals.map(x=>x.id),['unknown','next','first']);
  assert.equal(groups[0].intervals[0].ended_at_ms,null);
  assert.equal(groups[1].reason,'chatters_poll_failed');
  assert.equal(groups[2].source,'youtube');
  assert.deepEqual(gaps,before);
  assert.deepEqual(groupCollectionGaps([]),[]);
});

test('gap labels describe known failures and keep unknown reasons inspectable',()=>{
  assert.match(gapReasonLabel('connection_lost_no_replay'),/Разрыв/);
  assert.match(gapReasonLabel('chatters_poll_incomplete'),/Неполный/);
  assert.match(gapReasonLabel('chatters_poll_failed'),/Не удалось/);
  assert.equal(gapReasonLabel('provider_custom'),'provider_custom');
});
