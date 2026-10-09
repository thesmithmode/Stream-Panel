import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
test('Twitch events attach to a YouTube-first logical stream and preserve timestamped category changes',()=>{
 const store=new StreamStore(':memory:');const at=Date.UTC(2026,9,1);
 try {
  const id=store.observePlatformStream('youtube','yt','video',at,at,null,'Live')!;
  store.observePlatformStream('twitch','tw','broadcast',at,at,null,'Live');
  store.streamSample(id,at,'dota','Dota 2','First',10);
  const event=(externalId:string,type:string,time:number,payload:Record<string,unknown>)=>({source:'twitch' as const,accountId:'tw',externalId,type,actor:null,occurredAtMs:time,receivedAtMs:time,sourceTime:null,timeQuality:'provider' as const,transport:'eventsub' as const,payload});
  store.ingest(event('update','channel.update',at+60000,{categoryId:'wow',categoryName:'World of Warcraft',title:'Second'}));
  assert.equal(store.events(id).length,1);
  const report:any=store.analytics({fromMs:at,toMs:at+120000});
  assert.deepEqual(report.categories.map((row:any)=>row.name),['Dota 2','World of Warcraft']);
  assert.deepEqual(report.categories.map((row:any)=>row.minutes),[1,1]);
  store.ingest(event('duplicate-time','channel.update',at,{categoryId:'dota',categoryName:'Dota 2',title:'Same time'}));
  assert.equal((store.analytics({fromMs:at,toMs:at+120000}) as any).timeline[0].twitchViewers,10);
 }finally{store.close();}
});
