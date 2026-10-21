import test from 'node:test';import assert from 'node:assert/strict';import {readRoute,routeUrl} from './route.ts';
test('stream, person and profile survive reload and history; invalid routes do not create a broken screen',()=>{
 const route={view:'people',session:'stream id',person:'viewer',profile:'gulnaz'} as const;
 assert.deepEqual(readRoute(new URL(routeUrl(route),'https://fixture.test').search),route);
 assert.equal(readRoute('?view=stream').view,'sessions');assert.equal(readRoute('?view=missing').view,'sessions');assert.equal(readRoute('', 'gulnaz').profile,'gulnaz');
 assert.equal(readRoute('?view=stream&stream=stream').view,'stream');assert.equal(readRoute('?profile=ruslan').profile,'ruslan');
});
