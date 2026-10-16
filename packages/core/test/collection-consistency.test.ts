import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
import {eventKey,daDonorExternalId} from '../src/domain.js';
const at=Date.UTC(2026,9,15,12),minute=60000;
test('follow retries and snapshot precision count one signup, while later refollows remain separate',()=>{
 const s=new StreamStore(':memory:');try{
  const id=s.observePlatformStream('twitch','owner','stream',at,at,null,'Stream')!;
  const input={source:'twitch' as const,accountId:'owner',externalId:'delivery-one',type:'follow',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:at+minute+123,receivedAtMs:at+minute+500,sourceTime:null,timeQuality:'provider' as const,transport:'eventsub' as const,payload:{}};
  const first=s.ingest(input);assert.equal(first.inserted,true);
  assert.deepEqual(s.ingest({...input,externalId:'retry',occurredAtMs:at+minute+987}),{...first,inserted:false});
  s.followingSnapshot('twitch','owner',[{id:'viewer',name:'Viewer',followedAtMs:at+minute}],true,at+2*minute);
  assert.equal(s.followingAnalytics(id).newFollowers.length,1);
  assert.equal(s.ingest({...input,externalId:'refollow',occurredAtMs:at+3*minute}).inserted,true);
  assert.equal(s.followingAnalytics(id).newFollowers.length,2);
  assert.equal(s.ingest({...input,externalId:'another-viewer',actor:{externalId:'other',displayName:'Viewer'}}).inserted,true);
  assert.equal(s.followingAnalytics(id).newFollowers.length,3);
 }finally{s.close();}
});
test('stream cards and detail count the same messages after owner, bot, shared-chat and custom exclusions',()=>{
 const s=new StreamStore(':memory:');try{
  const id=s.observePlatformStream('twitch','owner','stream',at,at,null,'Stream')!;
  s.observePlatformStream('youtube','yt-owner','video',at,at,'https://youtube.com/watch?v=video','Title');
  for(const [externalId,name,origin] of [['owner','Owner','owner'],['bot','StreamElements','owner'],['custom','CustomBot','owner'],['viewer','Viewer','owner'],['shared','Shared viewer','other']])s.ingest({source:'twitch',accountId:'owner',externalId:`message-${externalId}`,type:'chat.message',actor:{externalId:externalId!,displayName:name!},occurredAtMs:at+minute,receivedAtMs:at+minute,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{originChannelId:origin}});
  for(const [author,name,owner] of [['yt-owner','YT Owner',true],['yt-bot','StreamElements',false],['yt-viewer','YT Viewer',false]])s.youtubeMessages('yt-owner','chat',[{id:String(author),snippet:{type:'textMessageEvent',publishedAt:new Date(at+minute).toISOString()},authorDetails:{channelId:author,displayName:name,isChatOwner:owner}}]);
  s.endSession(id,at+2*minute);
  for(const excluded of [[],['CustomBot']]){
   const card=s.sessions(id,0,100,excluded)[0]!;
   assert.equal(card.messageCount,s.summary(id,excluded,false).messages);
   assert.equal(card.messageCount,excluded.length?2:3);
  }
 }finally{s.close();}
});
test('donation statistics exclude bot tips consistently while ledger retains them and old tips stay unlinked',()=>{
 const s=new StreamStore(':memory:');try{
  const id=s.observePlatformStream('twitch','owner','stream',at,at,null,'Stream')!;
  const tip={source:'donationalerts' as const,accountId:'da',externalId:'live-tip',type:'donation',actor:{externalId:daDonorExternalId('StreamElements'),displayName:'StreamElements'},occurredAtMs:at+minute,receivedAtMs:at+minute,sourceTime:null,timeQuality:'provider' as const,transport:'rest' as const,payload:{amountMinor:'22800',currency:'RUB'}};
  const real={...tip,actor:{externalId:daDonorExternalId('RealDonor'),displayName:'RealDonor'}};
  s.ingest(tip);s.ingest({...real,externalId:'real-tip'});s.ingest({...real,externalId:'before-stream',occurredAtMs:at-minute});
  s.endSession(id,at+2*minute);
  assert.equal(s.donations().total,3);
  assert.equal(s.channelOverview().donations,2);assert.deepEqual(s.channelOverview().totals,{RUB:'45600'});
  assert.equal(s.summary(id,[],false).donations,1);assert.equal(s.sessions(id)[0]!.donationCount,1);
  assert.deepEqual(s.summary(id,[],false).totals,{RUB:'22800'});
  assert.deepEqual(s.donation(eventKey({...tip,externalId:'before-stream'})).sessionIds,[]);
 }finally{s.close();}
});
