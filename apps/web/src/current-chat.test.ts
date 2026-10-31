import test from 'node:test';
import assert from 'node:assert/strict';
import {sortChat,messageAge,type CurrentChatter} from './current-chat.ts';
const people:CurrentChatter[]=[{key:'silent',name:'Silent',personId:'s',source:'twitch',minutes:10,messages:0,lastMessageAt:null},{key:'youtube',name:'YouTube',personId:'y',source:'youtube',minutes:null,messages:5,lastMessageAt:1000},{key:'talker',name:'Talker',personId:'t',source:'twitch',minutes:4,messages:2,lastMessageAt:2000}];
test('all table metrics sort with unknown values last and keep silent users',()=>{
 assert.deepEqual(sortChat(people,'','messages',true).map(p=>p.key),['youtube','talker','silent']);
 assert.deepEqual(sortChat(people,'','minutes',false).map(p=>p.key),['talker','silent','youtube']);
 assert.deepEqual(sortChat(people,'','lastMessageAt',true).map(p=>p.key),['talker','youtube','silent']);
 assert.deepEqual(sortChat(people,'@youtube','name',false).map(p=>p.key),['youtube']);
 assert.equal(people[0]!.key,'silent','sorting does not mutate incoming snapshots');
 assert.equal(messageAge(null,5000),'Не писал');assert.equal(messageAge(1000,5000),'Только что');assert.equal(messageAge(1000,121000),'2 мин назад');
});
