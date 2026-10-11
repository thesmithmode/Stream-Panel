import test from 'node:test';import assert from 'node:assert/strict';import {isOutdatedRelease,uiRelease} from './release.ts';
test('release comparison detects stale production clients without reloading local previews or unknown versions',()=>{
 assert.equal(uiRelease,'development');assert.equal(isOutdatedRelease('a'.repeat(40),'b'.repeat(40)),true);assert.equal(isOutdatedRelease('a'.repeat(40),'a'.repeat(40)),false);assert.equal(isOutdatedRelease('development','a'.repeat(40)),false);assert.equal(isOutdatedRelease('a'.repeat(40),'development'),false);assert.equal(isOutdatedRelease(null),false);assert.equal(isOutdatedRelease('a'.repeat(40)),false);
});
