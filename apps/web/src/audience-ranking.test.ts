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

import {presenceMinutes,rankTable,intervalRows,durationLabel} from './audience-ranking.ts';
test('table combines overlapping platforms, retains zero rows, sorts exact currency amounts, and measures gaps',()=>{
 const intervals=[{from:0,to:120000,kind:'observed'},{from:60000,to:180000,kind:'chat_proxy'},{from:300000,to:360000,kind:'observed'}];
 assert.equal(presenceMinutes({id:'a',name:'A',intervals}),4);
 assert.equal(presenceMinutes({id:'a',name:'A',observedMinutes:2,estimatedChatMinutes:3}),5);
 const people=[{id:'a',name:'A',intervals,messages:0,donations:{RUB:'9007199254740992'}},{id:'b',name:'B',messages:2,donations:{RUB:'9007199254740993'}},{id:'c',name:'C'}];
 assert.deepEqual(rankTable(people,'presence').map(p=>p.id),['a','b','c']);
 assert.deepEqual(rankTable(people,'messages').map(p=>p.id),['b','a','c']);
 assert.deepEqual(rankTable(people,'donation:RUB').map(p=>p.id),['b','a','c']);
 assert.deepEqual(rankTable(people,'name',false).map(p=>p.id),['a','b','c']);
 assert.equal(intervalRows(intervals)[2].gap,180000);
 assert.equal(durationLabel(80),'1 ч 20 мин');assert.equal(durationLabel(60),'1 ч');assert.equal(durationLabel(0),'0 мин');
});
