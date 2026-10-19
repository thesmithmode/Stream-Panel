import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApplication} from '../src/server.js';
import {YouTubeConnection} from '../src/youtube.js';
import type {Configuration} from '../src/config.js';

test('real YouTube collection with omitted concurrentViewers keeps Twitch visible in HTTP history and analytics',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-partial-http-')),a=await createApplication(dir,47831,false);
 const base=Date.parse('2026-10-19T06:00:00Z'),now=base+10000,video='video_AAAAAA';
 const configuration={value:{youtube:{access:'access',refresh:'refresh',userId:'channel',scopes:['https://www.googleapis.com/auth/youtube.readonly'],expiresAt:now+3600000}},save:async()=>{}} as unknown as Configuration;
 let viewers:string|undefined;
 const request:typeof fetch=async input=>{
  const url=new URL(String(input));
  if(url.pathname.endsWith('/liveBroadcasts'))return Response.json({items:[{id:video,snippet:{channelId:'channel',title:'Monday',liveChatId:''}}]});
  if(url.pathname.endsWith('/videos'))return Response.json({items:[{id:video,liveStreamingDetails:{actualStartTime:new Date(base).toISOString(),...(viewers===undefined?{}:{concurrentViewers:viewers})}}]});
  return Response.json({});
 };
 const yt=new YouTubeConnection(configuration,a.db,'https://panel.test/oauth/youtube/callback','ruslan',request,()=>now);
 try{
  const headers={host:'127.0.0.1:47831'},key=new URLSearchParams(a.bootstrap().split('#')[1]).get('key')!;
  const login=await a.app.inject({method:'POST',url:'/api/v1/bootstrap',headers,payload:{key}}),cookie=String(login.headers['set-cookie']).split(';')[0]!;
  const read=async(url:string)=>{const r=await a.app.inject({method:'GET',url,headers:{...headers,cookie}});assert.equal(r.statusCode,200);return r.json();};
  const id=await a.db.call('observePlatformStream','twitch','owner','stream',base,base,null,'Monday');
  await a.db.call('streamSample',id!,base+3000,'dota','Dota 2','Monday',8);
  await a.db.call('youtubeSnapshot','channel','channel',{id:'channel'},now);await a.db.call('youtubeSnapshot','channel','report',{},now);
  await yt.collectOnce();
  const rows=await read('/api/v1/sessions');assert.equal(rows[0].viewerPartial,true);assert.equal(rows[0].viewerKnownPeak,8);assert.equal(rows[0].viewerPeak,null);
  let report=await read(`/api/v1/analytics?session=${id}&source=all&timezone=Europe%2FMoscow`);
  assert.equal(report.streamComparison[0].viewers.youtube.mean,null);assert.equal(report.streamComparison[0].viewers.known.peak,8);
  assert.equal(report.hours.find((h:any)=>h.day==='пн'&&h.hour===9).knownViewersTotal,8);
  // A subsequent confirmed zero must invalidate HTTP/cache results and remove the warning.
  viewers='0';await yt.collectOnce();
  const corrected=await read('/api/v1/sessions');assert.equal(corrected[0].viewerPartial,false);assert.equal(corrected[0].viewerPeak,8);
  report=await read(`/api/v1/analytics?session=${id}&source=all&timezone=Europe%2FMoscow`);
  assert.equal(report.streamComparison[0].viewers.youtube.mean,0);assert.equal(report.streamComparison[0].viewers.known.partialMinutes,0);
 }finally{await yt.stop();await a.app.close();await rm(dir,{recursive:true,force:true});}
});
