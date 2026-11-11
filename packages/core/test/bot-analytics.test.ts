import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
import {HistoryTimeline} from '../src/history-timeline.js';
import {clockActivitySeries} from '../src/clock-activity.js';
import {chartSeries} from '../../../apps/web/src/chart-series.js';
import {dailyMetrics} from '../../../apps/web/src/daily-metrics.js';
import {EVENT_RETENTION_MS} from '../src/recent-events.js';
const at=Date.UTC(2026,10,8),minute=60000;
test('both bot modes agree across cached stream, daily, category and clock charts without changing stored samples',()=>{
 const s=new StreamStore(':memory:');try{
  const id=s.startSession('owner','stream',at,'platform',at),users=['streamelements','bot1','bot2','human1','human2','human3'];
  for(const user of users){const person=s.ingest({source:'twitch',accountId:'owner',externalId:user,type:'chat.message',actor:{externalId:user,displayName:user},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hi'}}).personId!;if(user.startsWith('bot'))s.setPersonBot(person,true,s.personRevision(person));}
  s.streamSample(id,at,'game','Game','',7);s.recordPoll(id,'owner',{startedAtMs:at,completedAtMs:at+minute,status:'complete',userIds:users});s.endSession(id,at+minute);
  const q={fromMs:at,toMs:at+minute,sessionId:id,timezone:'UTC'},all=s.analytics({...q,excludedLogins:false}),clean=s.analytics(q);
  assert.equal(all.timeline[0]!.viewers,6);assert.equal(all.timeline[0]!.botViewers,2);assert.equal(clean.timeline[0]!.viewers,4);
  assert.equal(all.summary.messages,5);assert.equal(clean.summary.messages,3);assert.equal(s.sessions(id)[0]!.viewerMean,4);
  assert.equal(chartSeries(all.timeline,'viewers')[0]!.botValue,2);assert.equal(chartSeries(all.timeline,'messages')[0]!.botValue,2);
  assert.equal(chartSeries(clean.timeline,'viewers')[0]!.botValue,0);
  assert.equal(all.categories[0]!.botViewersTotal,2);assert.equal(all.categories[0]!.botMessages,2);
  assert.equal(clockActivitySeries(all.activityClock,'viewers',60,'all',true).find(p=>p.value!==null)!.botValue,2);
  const daily=dailyMetrics(all.streamComparison,'UTC');assert.equal(daily[0]!.botOnline,2);assert.equal(daily[0]!.online,6);
  const history=new HistoryTimeline('UTC',new Map());history.add(all);assert.equal(chartSeries(history.values(),'viewers',1440)[0]!.botValue,2);
  const repeat=s.analytics({...q,excludedLogins:false});assert.deepEqual(repeat.timeline,all.timeline);assert.equal(s.analytics(q).timeline[0]!.viewers,4);
  const raw=(s as any).db.prepare('SELECT twitch_viewers FROM stream_samples').get();assert.equal(raw.twitch_viewers,7);
  assert.equal(EVENT_RETENTION_MS,7*86400000);
 }finally{s.close();}
});

test('StreamElements on YouTube is a chatbot, while ordinary YouTube users stay human',()=>{
 const s=new StreamStore(':memory:');try{
  const id=s.startSession('owner','stream',at,'platform',at);s.attachPlatformStream(id,'youtube','yt-owner','video',at,at,null,'');
  for(const [user,name] of [['bot','StreamElements'],['human','Viewer']])s.youtubeMessages('yt-owner','chat',[{id:user,snippet:{type:'textMessageEvent',publishedAt:new Date(at).toISOString()},authorDetails:{channelId:user,displayName:name}}]);
  s.youtubeViewers(at,2,id);s.endSession(id,at+minute);
  const all=s.analytics({fromMs:at,toMs:at+minute,sessionId:id,youtubeAccount:'yt-owner',excludedLogins:false});
  assert.equal(all.audience.some(p=>p.name==='StreamElements'),false);assert.equal(all.timeline[0]!.botYoutubeMessages??0,0);assert.equal(all.timeline[0]!.botYoutubeViewers??0,0);
  const clean=s.analytics({fromMs:at,toMs:at+minute,sessionId:id,youtubeAccount:'yt-owner'});assert.deepEqual(clean.audience.map(p=>p.name),['Viewer']);assert.equal(clean.timeline[0]!.youtubeViewers,2);
 }finally{s.close();}
});
