import test from 'node:test';
import assert from 'node:assert/strict';
import {audienceRanking} from './audience-ranking.ts';
test('minutes rank includes silent participants and keeps estimates and missing observations separate',()=>{
 const people=[{id:'talker',name:'Talker',messages:20,observedMinutes:3},{id:'silent',name:'Silent',messages:0,observedMinutes:5},{id:'yt',name:'YouTube',messages:2,estimatedChatMinutes:30}];
 assert.deepEqual(audienceRanking(people,'observedMinutes').map(p=>p.id),['silent','talker']);
 assert.deepEqual(audienceRanking(people,'messages').map(p=>p.id),['talker','yt']);
 assert.deepEqual(audienceRanking(people,'estimatedChatMinutes').map(p=>p.id),['yt']);
 assert.equal(people[0].id,'talker');
 assert.deepEqual(audienceRanking([{id:'b',name:'Same',messages:1},{id:'a',name:'Same',messages:1}],'messages').map(p=>p.id),['a','b']);
});
