import test from 'node:test';
import assert from 'node:assert/strict';
import {sameResponse,rememberResponse,mergeResponseBlocks} from './response-equality.ts';
test('responses without validators never compare equal merely because fields look similar',()=>{
 const a={value:1};assert.equal(sameResponse(a,a),true);assert.equal(sameResponse(a,{value:1}),false);assert.equal(sameResponse(null,{}),false);assert.equal(sameResponse(null,null),true);
});

test('actual response ETags identify unchanged report values',()=>{const a={},b={};rememberResponse(a,'tag');rememberResponse(b,'tag');assert.equal(sameResponse(a,b),true);rememberResponse(b,'other');assert.equal(sameResponse(a,b),false);rememberResponse(null,'ignored');assert.equal(sameResponse(1,{}),false);});

test('compact block validators retain graph identity without deep comparison',()=>{const a={timeline:[1],summary:{core:1}},b={timeline:[1],summary:{core:2}};rememberResponse(a,'old',JSON.stringify({timeline:'stable',summary:'old'}));rememberResponse(b,'new',JSON.stringify({timeline:'stable',summary:'new'}));const merged=mergeResponseBlocks(a,b);assert.equal(merged.timeline,a.timeline);assert.equal(merged.summary,b.summary);assert.equal(sameResponse(merged,b),true);assert.equal(mergeResponseBlocks(null,b),b);assert.equal(mergeResponseBlocks({},b),b);rememberResponse({},'tag','invalid');rememberResponse({},'tag','null');});
