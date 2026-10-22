import test from 'node:test';import assert from 'node:assert/strict';
import {collectYouTubePublications,publicationKind} from '../src/youtube-publications.js';import {subscriberInterval} from '../src/subscriber-cadence.js';
import type {Publication} from '../../../packages/core/src/subscriber-history.js';
const at=Date.UTC(2026,9,22,12),iso=(n:number)=>new Date(n).toISOString();
function fixture(mode='ok'){
 let valid=true,requests=0;const saved:Publication[][]=[],cursors:string[]=[],calls:string[]=[];
 const d={account:'owner',at,valid:()=>valid,channel:{contentDetails:{relatedPlaylists:{uploads:'playlist'}}},snapshots:{} as Record<string,{data:any;updatedAt:number}>,
  api:async(resource:string,params:Record<string,string>):Promise<Record<string,any>>=>{
   requests++;calls.push(resource);
   if(mode==='network')throw new Error('offline');if(mode==='cancel')valid=false;
   if(resource==='playlistItems'){
    if(mode==='invalid-playlist')return {};
    const ids=params.pageToken?['short2']:['short1','long','stream','private','invalid','missing'];
    return {items:mode==='invalid-dates'?[{contentDetails:{videoId:'old',videoPublishedAt:iso(at-31*86400000)}},{contentDetails:{videoId:'future',videoPublishedAt:iso(at+1000)}},{contentDetails:{videoPublishedAt:'bad'}}]:ids.map(id=>({contentDetails:{videoId:id,videoPublishedAt:iso(at-3600000)}})),...(mode==='loop'?{nextPageToken:'same'}:mode==='limit'?{nextPageToken:String(requests)}:!params.pageToken?{nextPageToken:'next'}:{})};
   }
   if(mode==='invalid-videos')return {};
   return {items:params.id!.split(',').filter(id=>id!=='missing').map(id=>({id,snippet:{publishedAt:id==='invalid'?'bad':iso(at-3600000),title:id},status:{privacyStatus:id==='private'?'private':'public'},...(id==='stream'?{liveStreamingDetails:{actualEndTime:iso(at)}}:{})}))};
  },
  types:async()=>{if(mode==='types-failure')throw new Error('not ready');if(mode==='cancel-types')valid=false;return mode==='invalid-types'?{}:{columnHeaders:[{name:'video'},{name:'creatorContentType'}],rows:[['short1','SHORTS'],['long','VIDEO_ON_DEMAND'],['short2','UNSPECIFIED']]};},
  save:async(items:Publication[])=>{saved.push(items);if(mode==='cancel-save')valid=false;},
  cursor:async(key:string)=>{cursors.push(key);if(mode==='cancel-cursor')valid=false;}};
 return {d,saved,cursors,calls};
}
test('uploads retain publication times, exclude archives/private videos, classify authoritatively and retry missing types',async()=>{
 for(const mode of ['ok','types-failure','invalid-types','cancel','cancel-save','cancel-types','cancel-cursor','invalid-dates']){
  const {d,saved,cursors,calls}=fixture(mode);await collectYouTubePublications(d);
  if(['cancel','invalid-dates'].includes(mode)){assert.equal(saved.length,0);continue;}
  assert.deepEqual(saved[0]?.map(p=>p.id),['short1','long','short2']);assert.ok(saved[0]?.every(p=>p.publishedAt===at-3600000&&p.kind==='unknown'));
  if(mode==='ok'){assert.deepEqual(saved[1]?.map(p=>p.kind),['shorts','video','unknown']);assert.deepEqual(cursors,['cursor:publicationTypes','cursor:publications']);assert.equal(calls.filter(c=>c==='playlistItems').length,2);}
  if(['types-failure','invalid-types'].includes(mode)){assert.equal(saved.length,1);assert.deepEqual(cursors,['cursor:publications']);}
  if(['cancel-save','cancel-types'].includes(mode))assert.equal(cursors.length,0);
 }
});
test('uploads pagination failures cannot partially commit, polling is bounded and cached types are reused',async()=>{
 for(const mode of ['network','invalid-playlist','invalid-videos','loop','limit']){const {d,saved}=fixture(mode);await assert.rejects(()=>collectYouTubePublications(d));assert.equal(saved.length,0);}
 const f=fixture();f.d.snapshots['cursor:publications']={data:true,updatedAt:at};await collectYouTubePublications(f.d);assert.deepEqual(f.calls,[]);
 const g=fixture();g.d.channel={contentDetails:{relatedPlaylists:{uploads:''}}};await collectYouTubePublications(g.d);assert.deepEqual(g.calls,[]);
 const h=fixture();h.d.snapshots['cursor:publicationTypes']={data:true,updatedAt:at};await collectYouTubePublications(h.d);assert.equal(h.saved.length,1);assert.deepEqual(h.cursors,['cursor:publications']);
 assert.equal(subscriberInterval(true),60000);assert.equal(subscriberInterval(false),900000);
});
test('publication shapes use clip lengths before Analytics is ready and never include broadcast archives',async()=>{
 for(const [duration,expected] of [['PT2M','shorts'],['PT3M','shorts'],['PT15M1S','video'],['PT1H','video'],['P1D','video'],['PT0S','unknown'],['PT15M','unknown'],['PT4M','unknown'],['bad','unknown'],['P','unknown'],['PT','unknown'],['','unknown']] as const)assert.equal(publicationKind(duration),expected,duration);
 assert.equal(publicationKind(undefined),'unknown');
 const f=fixture('types-failure'),api=f.d.api;
 f.d.api=async(resource,params)=>{const response=await api(resource,params);if(resource==='videos'){assert.ok(params.part?.includes('contentDetails'));for(const row of response.items)row.contentDetails={duration:row.id==='long'?'PT18M':'PT2M'};}return response;};
 await collectYouTubePublications(f.d);
 assert.deepEqual(f.saved[0]?.map(p=>[p.id,p.kind]),[['short1','shorts'],['long','video'],['short2','shorts']]);
});
