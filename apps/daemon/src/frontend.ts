import {createServer,request as upstreamRequest} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {createGzip,gzip} from 'node:zlib';
import {pipeline} from 'node:stream';
import {promisify} from 'node:util';
import type {HostedNetworkConfig} from './hosted-network.js';
const types:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.webp':'image/webp'};
const compress=promisify(gzip);
function acceptsGzip(value:string|undefined){
 const encodings=new Map((value??'').toLowerCase().split(',').map(part=>{const [name,...parameters]=part.trim().split(';');const q=parameters.find(p=>p.trim().startsWith('q='));return [name,q?Number(q.trim().slice(2)):1] as const;}));
 return (encodings.get('gzip')??encodings.get('*')??0)>0;
}
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
    const outgoing={...reply.headers};
    // Compress only successful JSON reads. Backups/uploads keep their streaming
    // contract, and all private data retains the collector's no-store headers.
    const json=req.method==='GET'&&reply.statusCode===200&&String(outgoing['content-type']).startsWith('application/json')&&!outgoing['content-encoding'];
    if(json)outgoing.vary=[outgoing.vary,'Accept-Encoding'].filter(Boolean).join(', ');
    if(json&&acceptsGzip(req.headers['accept-encoding'])){
     delete outgoing['content-length'];delete outgoing.etag;outgoing['content-encoding']='gzip';
     res.writeHead(200,outgoing);pipeline(reply,createGzip({level:1}),res,()=>{});
    }else{res.writeHead(reply.statusCode??502,outgoing);pipeline(reply,res,()=>{});}
   });
   proxy.on('error',()=>{if(!res.headersSent){res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"COLLECTOR_UNAVAILABLE"}');}else res.destroy();});
   proxy.setTimeout(120000,()=>proxy.destroy());
   req.on('aborted',()=>proxy.destroy());res.on('close',()=>proxy.destroy());req.pipe(proxy);return;
  }
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
  if(path.endsWith('.map')){res.writeHead(404);res.end();return;}
  const file=resolve(base,'.'+path);
  if(file!==base&&!file.startsWith(base+'/')){res.writeHead(403);res.end();return;}
  try{
   let target=file;
   try{if(!(await stat(target)).isFile())target=resolve(base,'index.html');}
   catch{if(path.startsWith('/assets/')){res.writeHead(404);res.end();return;}target=resolve(base,'index.html');}
   let bytes=await readFile(target);
   const encoded=acceptsGzip(req.headers['accept-encoding'])&&bytes.length>=1024&&['.html','.js','.css','.svg'].includes(extname(target));
   if(encoded)bytes=await compress(bytes,{level:1});
   const immutable=/^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(js|css|svg|png|webp|woff2?)$/.test(path);
   res.writeHead(200,{'content-type':types[extname(target)]??'application/octet-stream','content-length':bytes.length,'cache-control':immutable?'public, max-age=31536000, immutable':'no-store',vary:'Accept-Encoding',...(encoded?{'content-encoding':'gzip'}:{}),'x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"});
   res.end(req.method==='HEAD'?undefined:bytes);
  }catch{res.writeHead(503);res.end();}
 });
}
