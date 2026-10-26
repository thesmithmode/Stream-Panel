import {createHash} from 'node:crypto';
import type {FastifyReply,FastifyRequest} from 'fastify';
/** Called inside authenticated routes; private profiles never share response validators. */
export function conditionalResponse(request:FastifyRequest,reply:FastifyReply,value:unknown){
 if(value&&typeof value==='object'&&'preparing' in value&&value.preparing)return value;
 const etag='"'+createHash('sha256').update(JSON.stringify(value)).digest('base64url')+'"';
 reply.header('Cache-Control','private, no-cache').header('Vary','X-Stream-Panel-Profile, Cookie').header('ETag',etag);
 const validators=String(request.headers['if-none-match']??'').split(',').map(v=>v.trim().replace(/^W\//,''));
 if(validators.includes(etag))return reply.code(304).send();
 return value;
}
