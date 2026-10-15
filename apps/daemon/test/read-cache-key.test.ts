import test from 'node:test';
import assert from 'node:assert/strict';
import {readCacheKey} from '../src/read-cache-key.js';
const now=Date.parse('2026-10-15T08:00:00Z');
test('moving analytics and People windows reuse polling keys but expire at the next interval',()=>{
 const args=(at:number)=>[{fromMs:0,toMs:at,source:'all',sessionId:'stream'}];
 assert.equal(readCacheKey('analytics',args(now),now),readCacheKey('analytics',args(now+15000),now+15000));
 assert.notEqual(readCacheKey('analytics',args(now),now),readCacheKey('analytics',args(now+30000),now+30000));
 for(const days of [7,30]){
  const people=(at:number)=>['',[],at-days*86400000];
  assert.equal(readCacheKey('persons',people(now),now),readCacheKey('persons',people(now+15000),now+15000));
  const top=(at:number)=>['donations',undefined,[],50,at-days*86400000,undefined,'RUB'];
  assert.equal(readCacheKey('personsTop',top(now),now),readCacheKey('personsTop',top(now+15000),now+15000));
 }
});
test('historical endpoints, filters, searches and periods remain distinct',()=>{
 const first={fromMs:0,toMs:now-86400000,source:'all'};
 assert.equal(readCacheKey('analytics',[first],now),readCacheKey('analytics',[first],now+15000));
 assert.notEqual(readCacheKey('analytics',[first],now),readCacheKey('analytics',[{...first,toMs:first.toMs+1}],now));
 assert.notEqual(readCacheKey('analytics',[first],now),readCacheKey('analytics',[{...first,source:'youtube'}],now));
 assert.notEqual(readCacheKey('persons',['a',[],0],now),readCacheKey('persons',['b',[],0],now));
 assert.notEqual(readCacheKey('persons',['',[],now-7*86400000],now),readCacheKey('persons',['',[],now-30*86400000],now));
 assert.equal(readCacheKey('summary',['stream'],now),readCacheKey('summary',['stream'],now+15000));
});
