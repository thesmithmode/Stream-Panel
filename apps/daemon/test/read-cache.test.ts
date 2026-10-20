import test from 'node:test';import assert from 'node:assert/strict';import {ReadCache,READ_CACHE_TTL_MS} from '../src/read-cache.js';
import net from 'node:net';
test('local-only cache preserves cloneable values without requiring JSON serialization',async()=>{
 const cache=new ReadCache('');try{
  const value={amount:100n};let loads=0;
  const first=await cache.read('native',async()=>{loads++;return value;});
  first.amount=0n;
  assert.deepEqual(await cache.read('native',async()=>{loads++;return value;}),{amount:100n});
  assert.equal(loads,1);
 }finally{cache.close();}
});
test('cached reads deduplicate, clone results, and invalidate immediately after writes',async()=>{
 const cache=new ReadCache('');let count=0;
 const load=async()=>{count++;return {rows:[count]};};
 const [a,b]=await Promise.all([cache.read('ruslan',load),cache.read('ruslan',load)]);assert.equal(count,1);a.rows[0]=99;assert.equal(b.rows[0],1);
 assert.equal((await cache.read('ruslan',load)).rows[0],1);assert.equal((await cache.read('gulnaz',load)).rows[0],2);
 cache.invalidate();assert.equal((await cache.read('ruslan',load)).rows[0],3);cache.close();
});
test('a slow pre-mutation read cannot repopulate the cache or overwrite a new read',async()=>{
 const cache=new ReadCache('');let resolve!:(n:number)=>void;const old=cache.read('key',()=>new Promise<number>(r=>resolve=r));
 cache.invalidate();assert.equal(await cache.read('key',async()=>2),2);resolve(1);assert.equal(await old,1);assert.equal(await cache.read('key',async()=>3),2);cache.close();
});
test('failed reads are not cached; unavailable Redis falls back to SQLite',async()=>{
 const malformed=new ReadCache('not a redis URL');assert.equal(await malformed.read('key',async()=>undefined),undefined);malformed.close();const cache=new ReadCache('redis://127.0.0.1:1');await assert.rejects(cache.read('bad',async()=>{throw new Error('failure');}));assert.equal(await cache.read('bad',async()=>4),4);cache.close();
});
test('Redis cache handles hits, corrupt values, deadlines and bounded local eviction',async t=>{
 const values=new Map<string,string>(),expires=new Map<string,number>();let mode='normal';const sockets=new Set<net.Socket>();
 const server=net.createServer(socket=>{
  socket.setNoDelay(true);sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer='';
  socket.on('data',chunk=>{buffer+=chunk.toString();for(;;){
   const header=buffer.indexOf('\r\n');if(header<0)return;
   const count=Number(buffer.slice(1,header));let at=header+2;const parts:string[]=[];
   for(let i=0;i<count;i++){const end=buffer.indexOf('\r\n',at);if(end<0)return;const length=Number(buffer.slice(at+1,end));at=end+2;if(buffer.length<at+length+2)return;parts.push(buffer.slice(at,at+length));at+=length+2;}
   buffer=buffer.slice(at);const command=parts[0]!.toUpperCase();
   if(command==='GET'){if(mode==='timeout')continue;const value=mode==='corrupt'?'invalid JSON':mode==='bad-gzip'?JSON.stringify({until:Date.now()+60000,encoding:'gzip',payload:'aW52YWxpZA=='}):(expires.get(parts[1]!)!>Date.now()?values.get(parts[1]!):undefined);socket.write(value===undefined?'$-1\r\n':`$${Buffer.byteLength(value)}\r\n${value}\r\n`);}
   else {if(command==='SET'){values.set(parts[1]!,parts[2]!);expires.set(parts[1]!,Date.now()+Number(parts[4]));}socket.write('+OK\r\n');}
  }});
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const cache=new ReadCache(`redis://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
 const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,20));
 try{
  await tick();await tick();let loads=0;
  assert.equal(await cache.read('key',async()=>++loads),1);await tick();
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  t.mock.timers.tick(15000);
  for(let n=0;n<129;n++)await cache.read(`evict-${n}`,async()=>n);
  assert.equal(await cache.read('key',async()=>++loads),1,'Redis serves an evicted local entry');
  t.mock.timers.tick(15001);
  assert.equal(await cache.read('key',async()=>++loads),2,'Redis hits must not extend the original freshness deadline');
  t.mock.timers.reset();
  // Eviction leaves the shared Redis value available.
  for(let n=0;n<129;n++)await cache.read(`other-${n}`,async()=>n);
  assert.equal(await cache.read('key',async()=>++loads),2);assert.equal(loads,2);
  mode='corrupt';assert.equal(await cache.read('corrupt',async()=>8),8);
  mode='normal';assert.equal((await cache.read('large',async()=> 'x'.repeat(2_000_001))).length,2_000_001);
  const policy={ttlMs:86400000,compressed:true},large='z'.repeat(2_100_000);let analyticsLoads=0;
  assert.equal(await cache.read('compressed',async()=>{analyticsLoads++;return large;},policy),large);await tick();
  for(let n=0;n<129;n++)await cache.read(`compressed-evict-${n}`,async()=>n);
  t.mock.timers.enable({apis:['Date'],now:Date.now()});t.mock.timers.tick(READ_CACHE_TTL_MS+1);
  assert.equal(await cache.read('compressed',async()=>{analyticsLoads++;return large;},policy),large);assert.equal(analyticsLoads,1,'Redis retains large compressed reports after the normal read TTL');
  t.mock.timers.reset();cache.invalidate();await cache.read('compressed',async()=>{analyticsLoads++;return large;},policy);assert.equal(analyticsLoads,2);
  mode='bad-gzip';assert.equal(await cache.read('bad-compression',async()=>11,policy),11);mode='normal';
  await tick();const retained=values.size;await cache.read('compression-limit',async()=>'x'.repeat(16_000_001),policy);await tick();assert.equal(values.size,retained);
  mode='timeout';const start=Date.now();assert.equal(await cache.read('deadline',async()=>9),9);assert.ok(Date.now()-start<500);assert.equal(await cache.read('after-timeout',async()=>10),10);
  mode='normal';t.mock.timers.enable({apis:['Date'],now:Date.now()+5001});
  await cache.read('reconnect',async()=>1);await tick();await tick();
  let recoveredLoads=0;await cache.read('recovered',async()=>++recoveredLoads);await tick();
  for(let n=0;n<129;n++)await cache.read(`recovered-evict-${n}`,async()=>n);
  assert.equal(await cache.read('recovered',async()=>++recoveredLoads),1,'Redis reconnects after a read deadline');assert.equal(recoveredLoads,1);t.mock.timers.reset();
  await tick();assert.ok([...values.values()].every(value=>value.length<2_000_000));
 }finally{cache.close();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('expired local values reload without returning stale snapshots',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1000});const cache=new ReadCache('');try{assert.equal(await cache.read('key',async()=>1),1);t.mock.timers.tick(READ_CACHE_TTL_MS+1);assert.equal(await cache.read('key',async()=>2),2);}finally{cache.close();t.mock.timers.reset();}
});

test('local cache bounds total serialized bytes and never retains oversized analytics responses',async()=>{
 const cache=new ReadCache('');const inspect=cache as unknown as {local:Map<string,unknown>;localBytes:number};
 try{
  for(let i=0;i<20;i++)await cache.read(String(i),async()=>({payload:'x'.repeat(1_000_000)}));
  assert.ok(inspect.localBytes<=8_000_000);assert.ok(inspect.local.size<20);
  let loads=0;await cache.read('huge',async()=>{loads++;return 'x'.repeat(2_000_001);});await cache.read('huge',async()=>{loads++;return 'x'.repeat(2_000_001);});assert.equal(loads,2);
  cache.invalidate();assert.equal(inspect.localBytes,0);
 }finally{cache.close();}
});

test('unchanged reports survive several polling cycles but expire without writes',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1000});const cache=new ReadCache('');let loads=0;
 try{await cache.read('report',async()=>++loads);t.mock.timers.tick(15000);assert.equal(await cache.read('report',async()=>++loads),1);t.mock.timers.tick(READ_CACHE_TTL_MS);assert.equal(await cache.read('report',async()=>++loads),2);}finally{cache.close();t.mock.timers.reset();}
});


test('analytics retention is revision-scoped while preparation responses are never retained',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1000});const cache=new ReadCache(''),policy={ttlMs:86400000,compressed:true};let loads=0;
 try{await cache.read('analytics',async()=>++loads,policy);t.mock.timers.tick(3600000);assert.equal(await cache.read('analytics',async()=>++loads,policy),1);cache.invalidate();assert.equal(await cache.read('analytics',async()=>++loads,policy),2);
 let preparing=0;for(let i=0;i<2;i++)await cache.read('building',async()=>({preparing:true,ready:++preparing}),policy);assert.equal(preparing,2);
 }finally{cache.close();t.mock.timers.reset();}
});

 test('large reports remain locally cached with compression and invalidate on writes without Redis',async()=>{
 const cache=new ReadCache(''),policy={ttlMs:86400000,compressed:true};let loads=0;
 try{const load=async()=>{loads++;return {rows:Array.from({length:30000},(_,i)=>({id:i,text:'content'.repeat(12)}))};};
  const first=await cache.read('report',load,policy);first.rows[0]!.text='changed';
  const second=await cache.read('report',load,policy);assert.equal(loads,1);assert.equal(second.rows[0]!.text,'content'.repeat(12));
  const inspect=cache as unknown as {localBytes:number};assert.ok(inspect.localBytes<2_000_000);
  cache.invalidate();await cache.read('report',load,policy);assert.equal(loads,2);
 }finally{cache.close();}
 });
