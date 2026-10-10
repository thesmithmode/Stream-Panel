import {createServer,request as upstreamRequest} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import type {HostedNetworkConfig} from './hosted-network.js';
const types:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.webp':'image/webp'};
/** Static UI and streaming API gateway. Never opens SQLite or provider credentials. */
export function createFrontend(root:string,collectorPort:number,origin:string,network:HostedNetworkConfig){
 const host=new URL(origin).host,base=resolve(root);
 return createServer(async(req,res)=>{
  if(req.headers.host!==host){res.writeHead(403);res.end();return;}
  let path:string;
  try{path=decodeURIComponent(new URL(req.url??'/',origin).pathname);}catch{res.writeHead(400);res.end();return;}
  if(path==='/healthz'||path.startsWith('/api/')||path.startsWith('/oauth/')){
   const headers={...req.headers};delete headers.connection;
   const peer=(req.socket.remoteAddress??'').replace(/^::ffff:/,'');
   const trusted=network.trustedProxies.includes(peer);
   headers['x-forwarded-for']=trusted&&headers['x-forwarded-for']?`${headers['x-forwarded-for']}, ${peer}`:peer;
   if(!trusted){delete headers['x-forwarded-host'];delete headers['x-forwarded-proto'];}
   const proxy=upstreamRequest({hostname:'127.0.0.1',port:collectorPort,path:req.url,method:req.method,headers},reply=>{
    res.writeHead(reply.statusCode??502,reply.headers);reply.pipe(res);reply.on('error',()=>res.destroy());
   });
   proxy.on('error',()=>{if(!res.headersSent){res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"COLLECTOR_UNAVAILABLE"}');}else res.destroy();});
   proxy.setTimeout(120000,()=>proxy.destroy());
   req.on('aborted',()=>proxy.destroy());res.on('close',()=>proxy.destroy());req.pipe(proxy);return;
  }
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
  const file=resolve(base,'.'+path);
  if(file!==base&&!file.startsWith(base+'/')){res.writeHead(403);res.end();return;}
  try{
   let target=file;
   try{if(!(await stat(target)).isFile())target=resolve(base,'index.html');}
   catch{if(path.startsWith('/assets/')){res.writeHead(404);res.end();return;}target=resolve(base,'index.html');}
   const bytes=await readFile(target);
   res.writeHead(200,{'content-type':types[extname(target)]??'application/octet-stream','content-length':bytes.length,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"});
   res.end(req.method==='HEAD'?undefined:bytes);
  }catch{res.writeHead(503);res.end();}
 });
}
