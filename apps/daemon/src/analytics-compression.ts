import type {FastifyInstance} from 'fastify';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
const compress=promisify(gzip);
/** Compress only public report payloads; session/credential responses stay separate. */
export function registerAnalyticsCompression(app:FastifyInstance){
 app.addHook('onSend',async(request,reply,payload)=>{
  if(request.method!=='GET'||reply.statusCode!==200||!/^\/api\/v1\/analytics(?:\/(?:clock|audience))?$/.test(request.url.split('?')[0]!))return payload;
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
  const zipped=await compress(payload,{level:1});
  if(zipped.length>=Buffer.byteLength(payload))return payload;
  reply.header('Content-Encoding','gzip').removeHeader('Content-Length');
  return zipped;
 });
}
