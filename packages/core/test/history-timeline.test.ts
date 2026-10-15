import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
import {audienceAnalytics} from '../src/analytics.js';
import {HistoryTimeline} from '../src/history-timeline.js';
const at=Date.UTC(2026,9,1),minute=60000;
function fixture(){
 const store=new StreamStore(':memory:');
 const id=store.startSession('owner','stream',at,'platform',at);
 store.ingest({source:'twitch',accountId:'owner',externalId:'message',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{count:1}});
 store.endSession(id,at+3*minute);
 return {store,report:audienceAnalytics((store as any).db,{fromMs:at,toMs:at+3*minute,timezone:'UTC',ownerId:'owner'})};
}
test('daily means weight partial minutes, keep unknown platform samples distinct from zero and sum messages',()=>{
 const {store,report}=fixture();try{
 const p=report.timeline[0]!;
 report.activityWindows=[{...report.activityWindows[0]!,from:at+30000,to:at+2*minute}];
 report.timeline=[
 {...p,at,presenceKnown:true,observed:2,estimated:4,participants:6,twitchViewers:0,youtubeViewers:10,messages:2,twitchMessages:1,youtubeMessages:1,viewersPartial:true},
 {...p,at:at+minute,presenceKnown:false,observed:100,estimated:1,participants:3,twitchViewers:null,youtubeViewers:4,messages:3,twitchMessages:1,youtubeMessages:2},
 {...p,at:at+2*minute,messages:100,twitchViewers:100,youtubeViewers:100}
 ];
 report.audience=[];
 const h=new HistoryTimeline('UTC',new Map());h.add(report);
 const [row]=h.values();assert.ok(row);
 assert.equal(row.observed,2);assert.equal(row.estimated,2);assert.equal(row.participants,4);
 assert.equal(row.twitchViewers,0);assert.equal(row.youtubeViewers,6);assert.equal(row.viewers,6);
 assert.equal(row.messages,5);assert.equal(row.unknownMessages,5);assert.equal(row.viewersPartial,true);
 const unknown=new HistoryTimeline('UTC',new Map());unknown.add({...report,timeline:[{...p,presenceKnown:false,twitchViewers:null,youtubeViewers:null}]});
 assert.equal(unknown.values()[0]!.viewers,null);assert.equal(unknown.values()[0]!.observed,0);
 }finally{store.close();}
});
test('daily cohort totals deduplicate overlapping presence and separate core, followers and unknown people',()=>{
 const {store,report}=fixture();try{
 const p=report.timeline[0]!,person=report.audience[0]!;
 report.activityWindows=[{...report.activityWindows[0]!,from:at,to:at+minute}];
 report.timeline=[{...p,presenceKnown:true,observed:2,estimated:1,participants:2,messages:7,twitchMessages:3,youtubeMessages:4,twitchViewers:null,youtubeViewers:4}];
 const observed={from:at,to:at+minute,session:'stream',kind:'observed' as const};
 const signals=[{at,source:'youtube',count:2},{at:at+86400000,source:'twitch',count:99}];
 report.audience=[{...person,id:'core',intervals:[observed,observed,{...observed,kind:'chat_proxy'},{...observed,from:at+minute,to:at+2*minute}],messageCounts:signals},
 {...person,id:'follower',intervals:[observed],messageCounts:[{at,source:'twitch',count:3}]},
 {...person,id:'unknown',intervals:[observed],messageCounts:signals}];
 const h=new HistoryTimeline('UTC',new Map([['core',{core:true,follower:true}],['follower',{core:false,follower:true}]]));h.add(report);
 const [row]=h.values();assert.ok(row);
 assert.equal(row.regularObserved,1);assert.equal(row.regularEstimated,1);assert.equal(row.regularParticipants,1);
 assert.equal(row.followerObserved,1);assert.equal(row.followerParticipants,1);
 assert.equal(row.regularYoutubeMessages,2);assert.equal(row.followerTwitchMessages,3);assert.equal(row.unknownMessages,2);assert.equal(row.unknownYoutubeMessages,2);
 assert.equal(row.viewers,4);
 }finally{store.close();}
});
