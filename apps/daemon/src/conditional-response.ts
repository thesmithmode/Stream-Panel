import {createHash} from 'node:crypto';
import type {FastifyReply,FastifyRequest} from 'fastify';
type Prepared={body:string;etag:string;blocks:Record<string,string>;analytical:boolean;bytes:number};
function prepare(request:FastifyRequest,value:unknown):Prepared{

 const blocks:Record<string,string>={};
 const analytical=request.routeOptions.url?.includes('/analytics')&&value&&typeof value==='object'&&!Array.isArray(value);
 const body=analytical?'{'+Object.entries(value as Record<string,unknown>).flatMap(([key,part])=>{const json=JSON.stringify(part);if(json===undefined)return [];blocks[key]=createHash('sha256').update(json).digest('base64url');return [JSON.stringify(key)+':'+json];}).join(',')+'}':JSON.stringify(value);
 const etag='"'+createHash('sha256').update(body).digest('base64url')+'"';
 return {body,etag,blocks,analytical:!!analytical,bytes:Buffer.byteLength(body)};
}
function send(request:FastifyRequest,reply:FastifyReply,prepared:Prepared){
 const {body,etag,blocks,analytical,bytes}=prepared;
 if(analytical){reply.header('X-Stream-Panel-Bytes',String(bytes));if(bytes>16384)reply.header('X-Stream-Panel-Blocks',JSON.stringify(blocks));}
 reply.header('Cache-Control','private, no-cache').header('Vary','X-Stream-Panel-Profile, Cookie, Accept-Encoding').header('ETag',etag);
 const validators=String(request.headers['if-none-match']??'').split(',').map(v=>v.trim().replace(/^W\//,''));
 if(validators.includes(etag))return reply.code(304).send();
 return reply.type('application/json').send(body);
}

/** Called only after authentication; preparing results are never cached. */
export function conditionalResponse(request:FastifyRequest,reply:FastifyReply,value:unknown){
 if(value&&typeof value==='object'&&'preparing' in value&&value.preparing)return value;
 return send(request,reply,prepare(request,value));
}
/** Route-local cache: the caller supplies exact filters, settings and authoritative versions.
 * No TTL can conceal a changed version. Keep wire bodies, not full report workspaces. */
export class PreparedResponses {
 private entries=new Map<string,Prepared>();
 private bytes=0;
 constructor(private readonly maxBytes=8*1024*1024){}
 async respond(request:FastifyRequest,reply:FastifyReply,key:string|undefined,load:()=>Promise<unknown>){
  const hit=key===undefined?undefined:this.entries.get(key);
  if(hit){this.entries.delete(key!);this.entries.set(key!,hit);return send(request,reply,hit);}
  const value=await load();
  if(value&&typeof value==='object'&&'preparing' in value&&value.preparing)return value;
  const prepared=prepare(request,value);
  if(key!==undefined&&prepared.bytes<=this.maxBytes){
   const old=this.entries.get(key);if(old){this.bytes-=old.bytes;this.entries.delete(key);}
   while(this.entries.size>=128||this.bytes+prepared.bytes>this.maxBytes){const oldest=this.entries.keys().next().value!;this.bytes-=this.entries.get(oldest)!.bytes;this.entries.delete(oldest);}
   this.entries.set(key,prepared);this.bytes+=prepared.bytes;
  }
  return send(request,reply,prepared);
 }
}
