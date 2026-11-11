import test from 'node:test';
import assert from 'node:assert/strict';
import {classificationScope} from './classification-scope.ts';
test('classification reads depend on profile, versions, visible membership and status, not report identity, ordering or attendance',()=>{
 const people=[{id:'a',is_bot:0,is_human:false,messages:1},{id:'b',is_bot:1,is_donor:false,messages:2}];
 const key=classificationScope('ruslan',1,'people-1',people);
 assert.equal(classificationScope('ruslan',1,'people-1',people.map(p=>({...p,messages:999})).reverse()),key);
 assert.notEqual(classificationScope('gulnaz',1,'people-1',people),key);
 assert.notEqual(classificationScope('ruslan',2,'people-1',people),key);
 assert.notEqual(classificationScope('ruslan',1,'people-2',people),key);
 assert.notEqual(classificationScope('ruslan',1,'people-1',people.slice(0,1)),key);
 for(const field of ['is_bot','is_human','is_donor'] as const)assert.notEqual(classificationScope('ruslan',1,'people-1',[{id:'a',[field]:true},people[1]!]),key);
});
