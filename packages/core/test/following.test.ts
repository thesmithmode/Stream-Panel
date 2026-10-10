import test from 'node:test';import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
const at=Date.UTC(2026,9,10,12),m=60000;
function event(s:StreamStore,id:string,type:'follow'|'chat.message',time:number,received=time){return s.ingest({source:'twitch',accountId:'owner',externalId:id,type,actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:time,receivedAtMs:received,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hi'}}).personId!;}
test('per-platform follow status distinguishes unknown, complete negative, subscription date, stream history and first chat signals',()=>{
 const s=new StreamStore(':memory:');try{
 const id=s.observePlatformStream('twitch','owner','one',at,at,null,'Stream')!,person=event(s,'message','chat.message',at);
 assert.equal(s.personFollowing(person)[0]!.status,null);assert.deepEqual(s.personFollowing(String(s.createPerson('No account').id)),[]);
 s.recordPoll(id,'owner',{startedAtMs:at,completedAtMs:at+m,status:'complete',userIds:['viewer']});
 s.followingSnapshot('twitch','owner',[],false,at);assert.equal(s.personFollowing(person,id)[0]!.streamStatus,null);
 s.followingSnapshot('twitch','owner',[],true,at+m);assert.equal(s.personFollowing(person,id)[0]!.status,false);
 s.followingSnapshot('twitch','owner',[{id:'viewer',name:'Viewer',followedAtMs:at+2*m},{id:'unlinked',name:'Other',followedAtMs:at+2*m}],true,at+3*m,2);
 s.endSession(id,at+4*m);s.followingSnapshot('twitch','owner',[],true,at+5*m,0);
 const state=s.personFollowing(person,id)[0]!;assert.equal(state.status,false);assert.equal(state.followedAtMs,at+2*m);assert.equal(state.streamStatus,true);assert.equal(state.firstMessageMs,at);assert.equal(state.firstSeenInChatMs,at+m);assert.equal(state.followedDuringStreamMs,at+2*m);assert.equal(state.history.length,4);
 const analytics=s.followingAnalytics(id);assert.equal(analytics.newFollowers.length,2);assert.equal(analytics.newFollowers[0]!.personId,person);assert.equal(analytics.newFollowers[1]!.personId,null);assert.equal(analytics.polls.length,3);
 // YouTube hides private subscribers: absence never proves a negative.
 s.youtubeMessages('channel','chat',[{id:'yt',snippet:{type:'textMessageEvent',publishedAt:new Date(at).toISOString(),displayMessage:'Hello'},authorDetails:{channelId:'author',displayName:'YT'}}]);const yt=String(s.persons().find(p=>p.sources==='youtube')!.id);
 s.followingSnapshot('youtube','channel',[],true,at+3*m);assert.equal(s.personFollowing(yt,id)[0]!.status,null);
 s.followingSnapshot('youtube','channel',[{id:'author',name:'YT',followedAtMs:null}],false,at+4*m);
 assert.equal(s.personFollowing(yt)[0]!.status,true);assert.equal(s.personFollowing(yt)[0]!.firstSeenInChatMs,at);assert.equal(s.personFollowing(yt)[0]!.followedAtMs,null);
 s.merge(yt,person,s.personRevision(yt),s.personRevision(person),at+5*m);assert.equal(s.personFollowing(person,id).length,2);
 assert.throws(()=>s.personFollowing('missing'),/PERSON_NOT_FOUND/);assert.throws(()=>s.personFollowing(person,'missing'),/SESSION_NOT_FOUND/);assert.throws(()=>s.followingAnalytics('missing'),/SESSION_NOT_FOUND/);
 }finally{s.close();}
});
test('EventSub follow beats an older poll and retains exact follow time after the stream',()=>{
 const s=new StreamStore(':memory:');try{
 const id=s.observePlatformStream('twitch','owner','one',at,at,null,'Stream')!,person=event(s,'message','chat.message',at);
 s.followingSnapshot('twitch','owner',[],true,at);event(s,'follow','follow',at+m,at+2*m);
 s.endSession(id,at+3*m);const row=s.personFollowing(person,id)[0]!;assert.equal(row.status,true);assert.equal(row.checkedAtMs,at+2*m);assert.equal(row.streamStatus,true);assert.equal(row.followedDuringStreamMs,at+m);assert.equal(s.followingAnalytics(id).newFollowers.length,1);
 const active=s.observePlatformStream('twitch','owner','next',at+40*m,at+40*m,null,'Next')!;assert.equal(s.personFollowing(person,active)[0]!.followedDuringStreamMs,null);assert.equal(s.followingAnalytics(active).newFollowers.length,0);
 s.followingSnapshot('twitch','owner',[{id:'viewer',name:'Viewer',followedAtMs:at+m},{id:'viewer',name:'New name',followedAtMs:at+m}],true,at+41*m);
 assert.equal(s.followingAnalytics(id).newFollowers.length,1);assert.equal(s.followingAnalytics(active).polls[0]!.total,1);
 }finally{s.close();}
});
test('follower snapshots reject malformed input without overwriting existing raw history',()=>{
 const s=new StreamStore(':memory:');try{
 for(const args of [['bad','owner',[],true,at],['twitch','',[],true,at],['twitch','owner',[],null,at],['twitch','owner',Array(25001).fill({}),true,at],['twitch','owner',[],true,at,-1],['twitch','owner',[],true,at,0.5],['twitch','owner',[{id:'',name:'x',followedAtMs:null}],true,at],['twitch','owner',[{id:'x',name:null,followedAtMs:null}],true,at],['twitch','owner',[{id:'x',name:'x',followedAtMs:-1}],true,at]])assert.throws(()=>(s.followingSnapshot as (...args:any[])=>void)(...args));
 }finally{s.close();}
});
