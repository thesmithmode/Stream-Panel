import test from 'node:test';
import assert from 'node:assert/strict';
import {windowsFromLinks} from '../src/session-windows.js';

test('batch provider windows retain overlap, interruptions, clipping and open broadcasts',()=>{
 const links=[{started_at_ms:300,ended_at_ms:null},{started_at_ms:100,ended_at_ms:200},{started_at_ms:150,ended_at_ms:250}];
 const before=structuredClone(links);
 assert.deepEqual(windowsFromLinks(links,120,400),[{from:120,to:250},{from:300,to:400}]);
 assert.deepEqual(links,before);
 assert.deepEqual(windowsFromLinks([],20,40),[{from:20,to:40}]);
 assert.deepEqual(windowsFromLinks([],40,20),[]);
 assert.deepEqual(windowsFromLinks(links,260,280),[]);
});
