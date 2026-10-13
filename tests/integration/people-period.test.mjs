import test from 'node:test';
import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';
test('people APIs accept only rolling 7/30-day periods and preserve lifetime defaults',async()=>{
 const a=await application();try{
  const host=new URL(a.origin).host,key=a.bootstrap().split('#key=')[1];
  const auth=await a.app.inject({method:'POST',url:'/api/v1/bootstrap',headers:{host,origin:a.origin},payload:{key}});
  assert.equal(auth.statusCode,200);
  const headers={host,cookie:auth.cookies.map(c=>`${c.name}=${c.value}`).join('; ')};
  const at=Date.now(),result=await a.db.call('ingest',{source:'twitch',accountId:'owner',externalId:'period',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'Hello'}});
  for(const endpoint of ['persons','persons/tops',`persons/${result.personId}/stats`]){
   for(const period of ['', '7','30']){const response=await a.app.inject({headers,url:`/api/v1/${endpoint}?period=${period}`});assert.equal(response.statusCode,200,response.body);}
   const response=await a.app.inject({headers,url:`/api/v1/${endpoint}?period=14`});assert.equal(response.statusCode,400);assert.equal(response.json().error,'INVALID_PERIOD');
  }
 }finally{await a.close();}
});
