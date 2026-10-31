import test from 'node:test';
import assert from 'node:assert/strict';
import {collectChatters} from '../src/chatters.js';
test('a positive provider total with no users is not a confirmed empty snapshot',async()=>{
 const failed=await collectChatters(async()=>({data:[],pagination:{},total:3}));assert.equal(failed.status,'failed');
 const empty=await collectChatters(async()=>({data:[],pagination:{},total:0}));assert.equal(empty.status,'complete');
 const partial=await collectChatters(async cursor=>cursor?{data:[],pagination:{},total:3}:{data:[{user_id:'1',user_login:'one',user_name:'One'}],pagination:{cursor:'next'},total:3});
 assert.equal(partial.status,'partial');assert.deepEqual(partial.userIds,['1']);
});
