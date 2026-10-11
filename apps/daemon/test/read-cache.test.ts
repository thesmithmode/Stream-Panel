import test from 'node:test';import assert from 'node:assert/strict';import {ReadCache} from '../src/read-cache.js';
import net from 'node:net';
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
 const cache=new ReadCache('redis://127.0.0.1:1');await assert.rejects(cache.read('bad',async()=>{throw new Error('failure');}));assert.equal(await cache.read('bad',async()=>4),4);cache.close();
});
test('Redis cache handles hits, corrupt values, deadlines and bounded local eviction',async t=>{
 const values=new Map<string,string>();let mode='normal';const sockets=new Set<net.Socket>();
 const server=net.createServer(socket=>{
  socket.setNoDelay(true);sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer='';
  socket.on('data',chunk=>{buffer+=chunk.toString();for(;;){
   const header=buffer.indexOf('\r\n');if(header<0)return;
   const count=Number(buffer.slice(1,header));let at=header+2;const parts:string[]=[];
   for(let i=0;i<count;i++){const end=buffer.indexOf('\r\n',at);if(end<0)return;const length=Number(buffer.slice(at+1,end));at=end+2;if(buffer.length<at+length+2)return;parts.push(buffer.slice(at,at+length));at+=length+2;}
   buffer=buffer.slice(at);const command=parts[0]!.toUpperCase();
   if(command==='GET'){if(mode==='timeout')continue;const value=mode==='corrupt'?'invalid JSON':values.get(parts[1]!);socket.write(value===undefined?'$-1\r\n':`$${Buffer.byteLength(value)}\r\n${value}\r\n`);}
   else {if(command==='SET')values.set(parts[1]!,parts[2]!);socket.write('+OK\r\n');}
  }});
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const cache=new ReadCache(`redis://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
 const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,20));
 try{
  await tick();await tick();let loads=0;
  assert.equal(await cache.read('key',async()=>++loads),1);await tick();
  // Eviction leaves the shared Redis value available.
  for(let n=0;n<129;n++)await cache.read(`other-${n}`,async()=>n);
  assert.equal(await cache.read('key',async()=>++loads),1);assert.equal(loads,1);
  mode='corrupt';assert.equal(await cache.read('corrupt',async()=>8),8);
  mode='timeout';const start=Date.now();assert.equal(await cache.read('deadline',async()=>9),9);assert.ok(Date.now()-start<500);
  mode='normal';assert.equal((await cache.read('large',async()=> 'x'.repeat(2_000_001))).length,2_000_001);
  await tick();assert.ok([...values.values()].every(value=>value.length<2_000_000));
 }finally{cache.close();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
