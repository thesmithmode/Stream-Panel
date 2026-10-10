import test from 'node:test';
import assert from 'node:assert/strict';
import type {Configuration} from '../src/config.js';
import type {StoreClient} from '../src/db.js';
import {YouTubeConnection} from '../src/youtube.js';

function connection(response:(url:URL)=>unknown) {
 const now=Date.UTC(2026,9,1,12);
 const config={value:{youtube:{access:'access',refresh:'refresh',userId:'owner',scopes:[],expiresAt:now+3600000}},save:async()=>{}} as unknown as Configuration;
 const db={call:async(method:string)=>method==='youtubeQuota'?true:null} as unknown as StoreClient;
 const request:typeof fetch=async input=>Response.json(response(new URL(String(input))));
 const instance=new YouTubeConnection(config,db,'https://panel.test/callback','profile',request,()=>now);
 return {instance,tokens:config.value.youtube!};
}

test('YouTube rejects malformed and duplicate active broadcast records',async()=>{
 const invalid=[
  {id:'bad id',snippet:{channelId:'owner'}},
  {id:'video',snippet:{channelId:'owner',liveChatId:42}},
  {id:'video',snippet:{channelId:'owner',title:42}},
  {id:'video',snippet:{}},
 ];
 for(const item of invalid) {
  const state=connection(()=>({items:[item]}));
  try {await assert.rejects((state.instance as any).activeBroadcasts(state.tokens,()=>true),/YOUTUBE_INVALID_BROADCASTS/);}
  finally {await state.instance.stop();}
 }
 const duplicate=connection(()=>({items:[{id:'video',snippet:{channelId:'owner'}},{id:'video',snippet:{channelId:'other'}}]}));
 try {await assert.rejects((duplicate.instance as any).activeBroadcasts(duplicate.tokens,()=>true),/YOUTUBE_INVALID_BROADCASTS/);}
 finally {await duplicate.instance.stop();}
});

test('YouTube rejects invalid, repeated, and overlong broadcast page tokens',async()=>{
 const invalid=connection(()=>({items:[],nextPageToken:42}));
 try {await assert.rejects((invalid.instance as any).activeBroadcasts(invalid.tokens,()=>true),/YOUTUBE_INVALID_BROADCASTS/);}
 finally {await invalid.instance.stop();}
 const oversized=connection(()=>({items:[],nextPageToken:'x'.repeat(513)}));
 try {await assert.rejects((oversized.instance as any).activeBroadcasts(oversized.tokens,()=>true),/YOUTUBE_INVALID_BROADCASTS/);}
 finally {await oversized.instance.stop();}
 let page=0;
 const repeated=connection(()=>({items:[],nextPageToken:page++===0?'same':'same'}));
 try {await assert.rejects((repeated.instance as any).activeBroadcasts(repeated.tokens,()=>true),/YOUTUBE_INVALID_BROADCASTS/);}
 finally {await repeated.instance.stop();}
 let count=0;
 const endless=connection(()=>({items:[],nextPageToken:`page-${++count}`}));
 try {await assert.rejects((endless.instance as any).activeBroadcasts(endless.tokens,()=>true),/YOUTUBE_BROADCAST_PAGINATION_LIMIT/);}
 finally {await endless.instance.stop();}
});
