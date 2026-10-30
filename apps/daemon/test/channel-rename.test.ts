import test from 'node:test';
import assert from 'node:assert/strict';
import {Configuration} from '../src/config.js';
import {StoreClient} from '../src/db.js';
import {TwitchConnection} from '../src/twitch.js';
import {YouTubeConnection} from '../src/youtube.js';

test('OAuth validation applies a Twitch rename to the existing owner and completed stream through the DB worker',async()=>{
  const db=new StoreClient(':memory:','ruslan');await db.ready;
  const config={value:{twitchClientId:'client123',twitch:{access:'access',refresh:'refresh',expiresAt:Date.now()+3600000,userId:'owner',scopes:['user:read:chat']}},save:async()=>{}} as unknown as Configuration;
  let login='Fullrandomname_twitch';
  const connection=new TwitchConnection(config,db,async()=>Response.json({client_id:'client123',user_id:'owner',login,scopes:['user:read:chat']}));
  try{
    const at=Date.now()-3600000;
    const sid=(await db.call('observePlatformStream','twitch','owner','broadcast',at,at,'https://www.twitch.tv/Fullrandomname_twitch','Past stream'))!;
    await db.call('endSession',sid,at+60000);
    await (connection as any).validate();
    const before=await db.call('persons');
    login='rlod';await (connection as any).validate();
    assert.equal(connection.status.account,'rlod');
    assert.equal(config.value.twitch?.userId,'owner');
    assert.equal(config.value.twitch?.refresh,'refresh');
    const after=await db.call('persons');
    assert.equal(after.length,1);assert.equal(after[0]!.id,before[0]!.id);
    assert.equal(after[0]!.display_name,'rlod');
    assert.equal(after[0]!.is_bot,1,'owner remains excluded');
    assert.deepEqual((await db.call('sessions',sid))[0]!.confirmedUrls,[{platform:'twitch',url:'https://www.twitch.tv/rlod'}]);
    assert.deepEqual(await db.call('candidatePersons','Fullrandomname_twitch'),[before[0]!.id]);
  }finally{await connection.stop();await db.stop();}
});

test('YouTube metadata refresh accepts the new name and handle with the same channel ID and credentials',async()=>{
  const db=new StoreClient(':memory:','ruslan');await db.ready;
  const now=Date.now();
  const config={value:{youtubeAccountId:'UC-original',youtube:{access:'access',refresh:'refresh',expiresAt:now+3600000,userId:'UC-original',scopes:[]}},save:async()=>{}} as unknown as Configuration;
  const requests:URL[]=[];
  const connection=new YouTubeConnection(config,db,'https://panel.test/oauth/youtube/callback','ruslan',async input=>{
    const url=new URL(String(input));requests.push(url);
    if(url.pathname.endsWith('/channels'))return Response.json({items:[{id:'UC-original',snippet:{title:'rlod_yt',customUrl:'@rlod_yt'},statistics:{subscriberCount:'10'}}]});
    return Response.json({items:[],columnHeaders:[],rows:[]});
  },()=>now);
  try{
    await db.call('youtubeSnapshot','UC-original','channel',{id:'UC-original',snippet:{title:'Fullrandomname'}},now-7*3600000);
    await connection.collectOnce();
    const data=await db.call('youtubeData','UC-original');
    assert.equal((data.snapshots.channel!.data as any).snippet.title,'rlod_yt');
    assert.equal((data.snapshots.channel!.data as any).snippet.customUrl,'@rlod_yt');
    assert.equal(connection.status.state,'connected');
    assert.equal(config.value.youtube?.userId,'UC-original');
    assert.equal(config.value.youtubeAccountId,'UC-original');
    assert.equal(config.value.youtube?.refresh,'refresh');
    assert.ok(requests.some(url=>url.searchParams.get('mine')==='true'));
    assert.ok(!requests.some(url=>url.pathname==='/token'||url.searchParams.has('forHandle')||url.searchParams.has('forUsername')));
  }finally{await connection.stop();await db.stop();}
});
