import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
const callHttp=(url:string,options:RequestInit={})=>new Promise<Response>((resolve,reject)=>{
 const req=request(url,{method:options.method??'GET',headers:options.headers as Record<string,string>},async res=>{const parts:Buffer[]=[];for await(const chunk of res)parts.push(Buffer.from(chunk));resolve(new Response(Buffer.concat(parts),{status:res.statusCode??500,headers:res.headers as Record<string,string>}));});req.on('error',reject);req.end(options.body);
});
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createFrontend} from '../src/frontend.js';
import {FrontendProcess} from '../src/frontend-process.js';
import {StreamStore} from '../../../packages/core/src/store.js';
const listen=(server:ReturnType<typeof createServer>)=>new Promise<number>(resolve=>server.listen(0,'127.0.0.1',()=>resolve((server.address() as {port:number}).port)));
const close=(server:ReturnType<typeof createServer>)=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});
test('frontend serves the SPA, rejects bad hosts and traversal, and preserves streamed API bodies, cookies and redirects',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sp-front-'));
 const backend=createServer(async(req,res)=>{
  const parts:Buffer[]=[];for await(const chunk of req)parts.push(Buffer.from(chunk));
  res.writeHead(req.url?.startsWith('/oauth/')?302:201,{'content-type':'application/json','set-cookie':'sp_session=opaque; HttpOnly','location':'/'});
  res.end(JSON.stringify({body:Buffer.concat(parts).toString(),path:req.url,forwarded:req.headers['x-forwarded-for'],proto:req.headers['x-forwarded-proto']??null}));
 });
 const backendPort=await listen(backend);let frontend:ReturnType<typeof createFrontend>|undefined;
 try{
  await mkdir(join(root,'assets'));await writeFile(join(root,'index.html'),'<title>Stream Panel</title>');await writeFile(join(root,'assets','app.js'),'window.fixture=true');
  frontend=createFrontend(root,backendPort,'https://panel.test',{bindHost:'127.0.0.1',trustedProxies:[]});const port=await listen(frontend);
  const call=(path:string,options:RequestInit={})=>callHttp(`http://127.0.0.1:${port}${path}`,{...options,headers:{host:'panel.test',...options.headers}});
  assert.match(await (await call('/')).text(),/Stream Panel/);assert.equal((await call('/nested-route')).status,200);
  assert.equal((await call('/assets/app.js',{method:'HEAD'})).headers.get('content-type'),'text/javascript; charset=utf-8');
  assert.equal((await call('/assets/missing.js')).status,404);assert.equal((await call('/%2e%2e%2fprivate')).status,403);
  assert.equal((await call('/%FF')).status,400);assert.equal((await call('/',{headers:{host:'evil.test'}})).status,403);
  assert.equal((await call('/',{method:'POST',body:'x'})).status,405);
  const reply=await call('/api/v1/test?x=1',{method:'POST',body:'x'.repeat(50000),headers:{'x-forwarded-for':'spoof','x-forwarded-proto':'https'}});
  assert.equal(reply.status,201);assert.match(reply.headers.get('set-cookie')!,/opaque/);const data=await reply.json();assert.equal(data.body.length,50000);assert.equal(data.forwarded,'127.0.0.1');assert.equal(data.proto,null);
  assert.equal((await call('/oauth/youtube/callback',{redirect:'manual'})).status,302);
  await close(frontend);frontend=createFrontend(root,backendPort,'https://panel.test',{bindHost:'127.0.0.1',trustedProxies:['127.0.0.1']});const trustedPort=await listen(frontend);
  const trusted=await callHttp(`http://127.0.0.1:${trustedPort}/healthz`,{headers:{host:'panel.test','x-forwarded-for':'1.2.3.4','x-forwarded-proto':'https'}});
  assert.equal((await trusted.json()).forwarded,'1.2.3.4, 127.0.0.1');
  await close(backend);assert.equal((await callHttp(`http://127.0.0.1:${trustedPort}/api/test`,{headers:{host:'panel.test'}})).status,503);
  await rm(join(root,'index.html'));assert.equal((await callHttp(`http://127.0.0.1:${trustedPort}/`,{headers:{host:'panel.test'}})).status,503);
 }finally{if(frontend)await close(frontend);if(backend.listening)await close(backend);await rm(root,{recursive:true,force:true});}
});

test('killing the frontend restarts only its process and keeps the stream writable',{timeout:10000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'sp-front-restart-')),s=new StreamStore(join(root,'data.sqlite'));
 const reservation=createServer();const port=await listen(reservation);await close(reservation);
 const frontend=new FrontendProcess(root,port+1,port,`http://127.0.0.1:${port}`,{bindHost:'127.0.0.1',trustedProxies:[]});
 try{
  await writeFile(join(root,'index.html'),'stream');const id=s.observePlatformStream('twitch','owner','stream',0,0,null,'')!;
  await frontend.start();const previous=frontend.pid!;process.kill(previous,'SIGKILL');
  s.streamSample(id,60000,'game','Game','After UI crash',4);
  const deadline=Date.now()+5000;while(!frontend.pid||frontend.pid===previous){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,30));}
  assert.equal(s.sessions()[0]!.id,id);assert.equal(s.sessions()[0]!.ended_at_ms,null);
  await frontend.stop();assert.equal(frontend.pid,undefined);await frontend.start();
 }finally{await frontend.stop();s.close();await rm(root,{recursive:true,force:true});}
});

test('an occupied frontend port fails safely without leaving a retry process',{timeout:10000},async()=>{
 const server=createServer(),port=await listen(server),front=new FrontendProcess('/tmp',port+1,port,'https://panel.test',{bindHost:'127.0.0.1',trustedProxies:[]});
 try{await assert.rejects(front.start(),/FRONTEND_START_FAILED/);}finally{await front.stop();await close(server);}
});
