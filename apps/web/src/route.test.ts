import test from 'node:test';import assert from 'node:assert/strict';import {readRoute,routeUrl} from './route.ts';
test('stream, person and profile survive reload and history; invalid routes do not create a broken screen',()=>{
 const route={view:'people',session:'stream id',person:'viewer',profile:'gulnaz'} as const;
 assert.deepEqual(readRoute(new URL(routeUrl(route),'https://fixture.test').search),route);
 assert.equal(readRoute('?view=stream').view,'overview');assert.equal(readRoute('?view=missing').view,'overview');assert.equal(readRoute('', 'gulnaz').profile,'gulnaz');
 assert.equal(readRoute('?view=stream&stream=stream').view,'stream');assert.equal(readRoute('?profile=ruslan').profile,'ruslan');
});
test('sections, person return context and people periods survive reload without external return URLs',()=>{
 const origin=routeUrl({view:'stream',session:'one',person:'',profile:'ruslan',section:'people'});
 const person={view:'people',session:'',person:'youtube:user',profile:'ruslan',section:'messages',period:'90',returnTo:origin} as const;
 assert.deepEqual(readRoute(new URL(routeUrl(person),'https://panel.test').search),person);
 for(const bad of ['https://evil.test/','//evil.test/','/?view=unknown','/?view=people&returnTo=x','/?view=stream&x='+ 'a'.repeat(2048)])assert.equal(readRoute('?view=people&returnTo='+encodeURIComponent(bad)).returnTo,undefined);
});
