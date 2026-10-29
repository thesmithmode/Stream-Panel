import {createHash} from 'node:crypto';
import type {FastifyReply,FastifyRequest} from 'fastify';
/** Called inside authenticated routes; private profiles never share response validators. */
export function conditionalResponse(request:FastifyRequest,reply:FastifyReply,value:unknown){
 if(value&&typeof value==='object'&&'preparing' in value&&value.preparing)return value;
 const blocks:Record<string,string>={};
 const analytical=request.routeOptions.url?.includes('/analytics')&&value&&typeof value==='object'&&!Array.isArray(value);
 const body=analytical?'{'+Object.entries(value as Record<string,unknown>).flatMap(([key,part])=>{const json=JSON.stringify(part);if(json===undefined)return [];blocks[key]=createHash('sha256').update(json).digest('base64url');return [JSON.stringify(key)+':'+json];}).join(',')+'}':JSON.stringify(value);
 const etag='"'+createHash('sha256').update(body).digest('base64url')+'"';
 if(analytical){const bytes=Buffer.byteLength(body);reply.header('X-Stream-Panel-Bytes',String(bytes));if(bytes>16384)reply.header('X-Stream-Panel-Blocks',JSON.stringify(blocks));}
 reply.header('Cache-Control','private, no-cache').header('Vary','X-Stream-Panel-Profile, Cookie').header('ETag',etag);
 const validators=String(request.headers['if-none-match']??'').split(',').map(v=>v.trim().replace(/^W\//,''));
 if(validators.includes(etag))return reply.code(304).send();
 return analytical?reply.type('application/json').send(body):value;
}
