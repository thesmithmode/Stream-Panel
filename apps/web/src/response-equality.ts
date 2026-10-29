/** Reuse the authenticated response validator; never serialize report data in UI. */
const tags=new WeakMap<object,string>();
const blocks=new WeakMap<object,Record<string,string>>();
export function rememberResponse(value:unknown,etag:string,header:string|null=null){
 if(!value||typeof value!=='object')return;tags.set(value,etag);
 if(header&&header.length<16384)try{const parsed=JSON.parse(header);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&Object.values(parsed).every(v=>typeof v==='string'))blocks.set(value,parsed);}catch{/* A missing/invalid optimization header never changes response data. */}
}
export function sameResponse(a:unknown,b:unknown){
 if(a===b)return true;
 if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
 const tag=tags.get(a);return !!tag&&tag===tags.get(b);
}

export function mergeResponseBlocks<T extends Record<string,unknown>>(previous:T|null,next:T):T{
 if(!previous)return next;
 const old=blocks.get(previous),current=blocks.get(next);if(!old||!current)return next;
 const merged=Object.fromEntries(Object.entries(next).map(([key,value])=>[key,current[key]&&old[key]===current[key]?previous[key]:value])) as T;
 blocks.set(merged,current);const tag=tags.get(next);if(tag)tags.set(merged,tag);return merged;
}
