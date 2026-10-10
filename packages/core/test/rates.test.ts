import test from 'node:test';
import assert from 'node:assert/strict';
import {minorPerHour,currencyRates} from '../src/rates.js';
test('donation efficiency keeps exact large amounts and currency separation with actual elapsed time',()=>{
 assert.equal(minorPerHour('1000000000000000000099',1800000),'2000000000000000000198');
 assert.equal(minorPerHour('1',7200000),'1');assert.equal(minorPerHour('1',10800000),'0');assert.equal(minorPerHour('0',30000),'0');
 assert.deepEqual(currencyRates({RUB:'10000',USD:'125'},900000),{RUB:'40000',USD:'500'});
 assert.deepEqual(currencyRates({},0),{});
});
test('unknown amounts and unavailable or invalid durations never invent zero efficiency',()=>{
 for(const amount of ['', 'NaN','1.1','-1'])assert.equal(minorPerHour(amount,60000),null);
 for(const duration of [0,-1,NaN,Infinity,.5,Number.MAX_SAFE_INTEGER+1])assert.equal(minorPerHour('100',duration),null);
 assert.deepEqual(currencyRates({RUB:'100'},0),{RUB:null});
});
