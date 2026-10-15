import test from 'node:test';
import assert from 'node:assert/strict';
import {latestRequest} from './latest-request.ts';

test('late responses cannot replace a newer scope, even when the transport ignores cancellation',async()=>{
 const request=latestRequest(),seen:string[]=[],failures:Error[]=[];
 request.cancel();
 let resolveOld!:(value:string)=>void;
 const old=request.run(()=>new Promise<string>(resolve=>{resolveOld=resolve;}),value=>seen.push(value),error=>failures.push(error));
 await request.run(async()=> 'new person',value=>seen.push(value));
 resolveOld('old person');await old;
 assert.deepEqual(seen,['new person']);assert.deepEqual(failures,[]);
 let rejectOld!:(error:Error)=>void;
 const discarded=request.run(()=>new Promise<string>((_resolve,reject)=>{rejectOld=reject;}),value=>seen.push(value),error=>failures.push(error));
 request.cancel();rejectOld(new Error('cancelled transport'));await discarded;
 await request.run(async()=>{throw Error('current error');},()=>{},error=>failures.push(error));
 assert.equal(failures[0]?.message,'current error');
 await request.run(async()=>{throw 'non-error';},()=>{},error=>failures.push(error));
 assert.equal(failures[1]?.message,'non-error');
 await request.run(async()=>{throw Error('ignored');},()=>{});
 request.cancel();
});
