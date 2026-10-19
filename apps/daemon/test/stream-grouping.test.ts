import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/server.js';
test('group endpoints validate input and CSRF, invalidate cached reads and preserve originals on undo',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-http-group-')),a=await createApplication(dir,47831,false),headers={host:'127.0.0.1:47831'};
 try{
  const key=new URLSearchParams(a.bootstrap().split('#')[1]).get('key')!;
  const login=await a.app.inject({method:'POST',url:'/api/v1/bootstrap',headers,payload:{key}}),cookie=String(login.headers['set-cookie']).split(';')[0]!,authorized={...headers,cookie,'x-csrf-token':login.json().csrf};
  const at=Date.now()-6*3600000,ids:string[]=[];
  for(let n=0;n<2;n++){const start=at+n*2*3600000,id=String(await a.db.call('startSession','owner',`part-${n}`,start,'platform',start));await a.db.call('endSession',id,start+120000);ids.push(id);}
  const read=()=>a.app.inject({method:'GET',url:'/api/v1/sessions',headers:{...headers,cookie}});
  assert.equal((await read()).json().length,2);
  const post=(url:string,payload:Record<string,unknown>)=>a.app.inject({method:'POST',url,headers:authorized,payload});
  assert.equal((await a.app.inject({method:'POST',url:'/api/v1/sessions/merge',headers:{...headers,cookie},payload:{sessionIds:ids}})).statusCode,403);
  for(const sessionIds of [[],[ids[0]],[ids[0],ids[0]],[ids[0],42]])assert.equal((await post('/api/v1/sessions/merge',{sessionIds})).statusCode,400);
  assert.equal((await post('/api/v1/sessions/merge',{sessionIds:[ids[0],'missing']})).statusCode,400);
  const merged=await post('/api/v1/sessions/merge',{sessionIds:ids});assert.equal(merged.statusCode,200);assert.equal(merged.json().id,ids[0]);
  const rows=(await read()).json();assert.equal(rows.length,1);assert.equal(rows[0].memberIds.length,2);
  assert.equal((await post(`/api/v1/sessions/${ids[0]}/unmerge`,{})).statusCode,200);assert.equal((await read()).json().length,2);
  assert.equal((await post(`/api/v1/sessions/${ids[0]}/unmerge`,{})).statusCode,404);
 }finally{await a.app.close();await rm(dir,{recursive:true,force:true});}
});
