import type {FastifyInstance} from 'fastify';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
const compress=promisify(gzip);
/** Compress only public report payloads; session/credential responses stay separate. */
export function registerAnalyticsCompression(app:FastifyInstance){
 const bodies=new Map<string,Buffer>();let bytes=0;
 app.addHook('onSend',async(request,reply,payload)=>{
  if(request.method!=='GET'||reply.statusCode!==200||!/^\/api\/v1\/analytics(?:\/(?:clock|audience|clock-summary))?$/.test(request.url.split('?')[0]!))return payload;
  if(typeof payload!=='string'&&!Buffer.isBuffer(payload)||reply.hasHeader('Content-Encoding'))return payload;
  const vary=String(reply.getHeader('Vary')??'');
  if(!vary.split(',').some(v=>v.trim().toLowerCase()==='accept-encoding'))reply.header('Vary',[vary,'Accept-Encoding'].filter(Boolean).join(', '));
  const encodings=String(request.headers['accept-encoding']??'').split(',').map(entry=>{
   const [name,...parameters]=entry.trim().toLowerCase().split(';');
   const q=parameters.find(p=>p.trim().startsWith('q='));
   return {name,quality:q===undefined?1:Number(q.trim().slice(2))};
  });
  const gzip=encodings.find(e=>e.name==='gzip')??encodings.find(e=>e.name==='*');
  if(!gzip||!(gzip.quality>0&&gzip.quality<=1)||Buffer.byteLength(payload)<8192)return payload;
  const key=typeof reply.getHeader('ETag')==='string'?String(reply.getHeader('ETag')):undefined;
  let zipped=key?bodies.get(key):undefined;
  if(!zipped){
   zipped=await compress(payload,{level:1});
   if(key&&zipped.length<Buffer.byteLength(payload)&&zipped.length<=2*1024*1024){
    const prior=bodies.get(key);if(prior){bytes-=prior.length;bodies.delete(key);}
    while(bodies.size>=128||bytes+zipped.length>4*1024*1024){const first=bodies.keys().next().value!;bytes-=bodies.get(first)!.length;bodies.delete(first);}
    bodies.set(key,zipped);bytes+=zipped.length;
   }
  }
  if(zipped.length>=Buffer.byteLength(payload))return payload;
  reply.header('Content-Encoding','gzip').removeHeader('Content-Length');
  return zipped;
 });
}
