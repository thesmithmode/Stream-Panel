import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamStore } from '../src/store.js';
import { audienceAnalytics, unionSpans } from '../src/analytics.js';
const minute = 60000, base = Date.UTC(2026, 9, 1, 12), end = base + 20 * minute;
function recordedStream(s:StreamStore, account:string, external:string, start:number, mode:'platform', observed:number) {
 const sid=s.startSession(account,external,start,mode,observed);
 s.observePlatformStream('youtube','yt-owner',`video-${external}`,start,observed,null,'Confirmed YouTube stream');
 return sid;
}
const opts = { fromMs: base, toMs: end, ownerId: 'owner', youtubeAccount: 'yt-owner', minSessions: 2, minMinutes: 2, minMessages: 2 };
test('analytics keeps owners/bots out, unions linked identities, splits categories, detects returns and distinguishes YouTube inference', () => {
    const s = new StreamStore(':memory:');
    const input = (id: string, actor: string, name: string, at: number, account = 'channel') => ({ source: 'twitch' as const, accountId: account, externalId: id, type: 'chat.message', actor: { externalId: actor, displayName: name }, occurredAtMs: at, receivedAtMs: at, timeQuality: 'provider' as const, sourceTime: null, transport: 'eventsub' as const, payload: { text: id } });
    try {
        const first = recordedStream(s,'channel', 'one', base, 'platform', base);
        s.streamSample(first, base, 'game', 'Game', 'First game', 12);
        s.streamSample(first, base + 5 * minute, 'talk', 'Talk', 'Switched', 15);
        const a = s.ingest(input('1', 'regular', 'Regular', base + minute));
        s.ingest(input('2', 'regular', 'Regular', base + 7 * minute));
        for (const [id, name] of [['owner', 'RenamedOwner'], ['jeetbot', 'jeetbot'], ['self', 'fullrandomname_twitch'], ['typo', 'streemelements']])
            s.ingest(input(id!, id!, name!, base + minute));
        s.recordPoll(first, 'channel', { startedAtMs: base, completedAtMs: base + minute, status: 'complete', userIds: ['regular', 'owner', 'jeetbot', 'self', 'typo'] });
        s.recordPoll(first, 'channel', { startedAtMs: base + minute, completedAtMs: base + 2 * minute, status: 'complete', userIds: ['regular'] });
        s.recordPoll(first, 'channel', { startedAtMs: base + 3 * minute, completedAtMs: base + 4 * minute, status: 'complete', userIds: [] });
        s.recordPoll(first, 'channel', { startedAtMs: base + 5 * minute, completedAtMs: base + 6 * minute, status: 'failed', userIds: ['regular'] });
        s.recordPoll(first, 'channel', { startedAtMs: base + 7 * minute, completedAtMs: base + 8 * minute, status: 'complete', userIds: ['regular'] });
        s.youtubeMessages('yt-owner', 'chat', [{ id: 'yt1', snippet: { type: 'textMessageEvent', publishedAt: new Date(base + minute).toISOString(), displayMessage: 'hello' }, authorDetails: { channelId: 'yt-regular', displayName: 'YouTubeRegular' } }, { id: 'yt-self', snippet: { type: 'textMessageEvent', publishedAt: new Date(base + minute).toISOString() }, authorDetails: { channelId: 'yt-owner', displayName: 'Me' } }, { id: 'yt-bot', snippet: { type: 'textMessageEvent', publishedAt: new Date(base + minute).toISOString() }, authorDetails: { channelId: 'yt-bot', displayName: 'streamelements' } }]);
        s.youtubeViewers(base, 4);
        s.endSession(first, base + 10 * minute, 'observed');
        const second = recordedStream(s,'channel', 'two', base + 10 * minute, 'platform', base + 10 * minute);
        s.streamSample(second, base + 10 * minute, 'game', 'Game', 'Game again', 10);
        s.recordPoll(second, 'channel', { startedAtMs: base + 10 * minute, completedAtMs: base + 11 * minute, status: 'complete', userIds: ['regular'] });
        s.ingest(input('3', 'regular', 'Regular', base + 11 * minute));
        s.youtubeMessages('yt-owner', 'chat2', [{ id: 'yt2', snippet: { type: 'textMessageEvent', publishedAt: new Date(base + 11 * minute).toISOString(), displayMessage: 'again' }, authorDetails: { channelId: 'yt-regular', displayName: 'YouTubeRegular' } }]);
        s.endSession(second, end, 'observed');
        const result = s.analytics(opts), regular = result.audience.find(x => x.id === a.personId)!, yt = result.audience.find(x => x.source === 'youtube')!;
        assert.equal(result.summary.entities, 2);
        assert.equal(result.summary.core, 2);
        assert.equal(regular.observedMinutes, 7);
        assert.equal(regular.visits, 3);
        assert.equal(regular.messages, 3);
        assert.equal(yt.observedMinutes, 0);
        assert.equal(yt.estimatedChatMinutes, 10);
        assert.equal(result.timeline.find(x => x.at === base + 3 * minute)?.presenceKnown, true);
        assert.equal(result.timeline.find(x => x.at === base + 5 * minute)?.presenceKnown, false);
        assert.equal(result.categories.find(x => x.id === 'game')?.messages, 4);
        assert.equal(result.categories.find(x => x.id === 'talk')?.messages, 1);
        assert.equal(result.timeline.find(x => x.at === base)?.viewers, 16);
        assert.equal(s.analytics({ ...opts, source: 'twitch' }).audience.length, 1);
        assert.equal(s.analytics({ ...opts, source: 'youtube' }).audience.length, 1);
        assert.equal(s.analytics({ ...opts, category: 'talk' }).audience[0]?.observedMinutes, 2);
        assert.equal(s.analytics({ ...opts, coreRule: 'both', minMessages: 10 }).summary.core, 0);
        assert.equal(s.analytics({ ...opts, coreRule: 'frequency', minSessions: 1, minMinutes: 1000 }).summary.core, 2);
        assert.equal(s.analytics({ ...opts, source: 'youtube', chatWindowMinutes: 1 }).audience[0]?.estimatedChatMinutes, 2);
        assert.equal(s.analytics({ ...opts, category: 'missing' }).summary.entities, 0);
        assert.ok(result.hours.some(x => x.hour === 15));
    }
    finally {
        s.close();
    }
});
test('analytics validates bounds and timezone, unknown categories remain unknown, overlapping inference is not double counted', () => {
    const s = new StreamStore(':memory:');
    try {
        for (const changes of [{ toMs: base }, { fromMs: -1 }, { toMs: 8640000000000001 }, { toMs: Number.MAX_SAFE_INTEGER + 1 }, { source: 'bad' }, { coreRule: 'bad' }, { minSessions: -1 }, { chatWindowMinutes: 31 }])
            assert.throws(() => s.analytics({ ...opts, ...changes } as any), /INVALID_ANALYTICS_FILTER/);
        assert.throws(() => s.analytics({ ...opts, timezone: 'bad/timezone' }), /INVALID_TIMEZONE/);
        const sid = recordedStream(s,'channel', 'unknown', base, 'platform', base);
        s.streamSample(sid, base + minute, 'game', 'Game', '', null);
        const spans = unionSpans([{ from: 0, to: 10, session: 's', kind: 'chat_proxy' }, { from: 2, to: 4, session: 's', kind: 'chat_proxy' }, { from: 10, to: 12, session: 's', kind: 'chat_proxy' }, { from: 3, to: 3, session: 's', kind: 'chat_proxy' }]);
        assert.equal(spans.length, 1);
        assert.equal(spans[0]!.to, 12);
        assert.equal(s.analytics(opts).categories.find(x => x.id === '')?.minutes, 1);
        assert.throws(() => s.streamSample(sid, -1, '', '', '', 1), /INVALID_TIMESTAMP/);
        assert.throws(() => s.streamSample(sid, base, '', '', '', -1), /INVALID_STREAM_SAMPLE/);
        assert.throws(() => s.youtubeViewers(base, -1), /INVALID_VIEWER_COUNT/);
    }
    finally {
        s.close();
    }
});
test('empty/default analytics is safe; too many sessions or expanded minutes require a narrower range, poll names exclude bots atomically', () => {
    const s = new StreamStore(':memory:');
    try {
        assert.equal(s.analytics({ fromMs: base, toMs: end }).summary.entities, 0);
        const sid = recordedStream(s,'channel', 'named', base, 'platform', base);
        s.recordPoll(sid, 'channel', { startedAtMs: base, completedAtMs: base + minute, status: 'complete', userIds: ['numeric-human', 'numeric-bot'], userNames: { 'numeric-human': 'NamedHuman', 'numeric-bot': 'jeetbot' } });
        assert.equal(s.analytics(opts).audience.length, 1);
        assert.equal(s.analytics(opts).audience[0]?.name, 'NamedHuman');
        s.endSession(sid, base + 2 * minute, 'observed');
        for (let n = 0; n < 1000; n++) {
            const id = recordedStream(s,'channel', `bounded-${n}`, base, 'platform', base);
            s.endSession(id, base + minute, 'observed');
        }
        assert.throws(() => s.analytics(opts), /ANALYTICS_RANGE_TOO_LARGE/);
    }
    finally {
        s.close();
    }
    const broad = new StreamStore(':memory:');
    try {
        const sid = broad.startSession('channel', 'overlong', base, 'platform', base);
        broad.recordPoll(sid, 'channel', { startedAtMs: base, completedAtMs: base + 89 * 86400000, status: 'complete', userIds: Array.from({ length: 16 }, (_, n) => `human-${n}`) });
        assert.throws(() => broad.analytics({ fromMs: base, toMs: base + 90 * 86400000 }), /ANALYTICS_RANGE_TOO_LARGE/);
    }
    finally {
        broad.close();
    }
});

test('analytics rejects oversized query result sets before expanding dashboard data',()=>{
 const store=new StreamStore(':memory:');
 const cases=[
  ['WITH raw AS(',{fromMs:base,toMs:end}],
  ['SELECT i.person_id,es.session_id,min(e.occurred_at_ms)',{fromMs:base,toMs:end}],
  ['SELECT i.person_id,es.session_id,e.occurred_at_ms AS at',{fromMs:base,toMs:end}],
  ['WITH scoped AS (',{fromMs:base,toMs:end,youtubeAccount:'yt-owner'}],
 ] as const;
 try {
  for(const [sqlPart,options] of cases){
   const raw=(store as any).db;
   const db=new Proxy(raw,{get(target,key){
    if(key==='prepare')return(sql:string)=>sql.includes(sqlPart)?{all:()=>Array.from({length:50001},()=>({}))}:target.prepare(sql);
    const value=Reflect.get(target,key,target);
    return typeof value==='function'?value.bind(target):value;
   }});
   assert.throws(()=>audienceAnalytics(db,{...options,ownerId:'owner'}),/ANALYTICS_RANGE_TOO_LARGE/);
  }
 } finally {store.close();}
});
test('excluded owner donations stay in raw history but never inflate summary or audience statistics', async () => {
    const { daDonorExternalId, moneyToMinor } = await import('../src/domain.js');
    assert.equal(moneyToMinor('42', 'RUB'), '4200');
    assert.throws(() => daDonorExternalId('  '), /INVALID_DA_DONOR_NAME/);
    const s = new StreamStore(':memory:');
    try {
        recordedStream(s,'channel', 'donations', base, 'platform', base);
        for (const [n, name] of ['fullrandomname_twitch', 'RealDonor'].entries())
            s.ingest({ source: 'donationalerts', accountId: 'da', externalId: String(n), type: 'donation', actor: { externalId: daDonorExternalId(name), displayName: name }, occurredAtMs: base + minute, receivedAtMs: base + minute, sourceTime: null, timeQuality: 'configured', transport: 'rest', payload: { amountMinor: '500', currency: 'RUB' } });
        const summary = s.summary(undefined, ['fullrandomname_twitch']);
        assert.equal(summary.donations, 1);
        assert.equal((summary.totals as any).RUB, '500');
        assert.equal(s.eventCount(), 2);
        const analytics = s.analytics(opts);
        assert.equal(analytics.audience.length, 1);
        assert.equal(analytics.audience[0]?.name, 'RealDonor');
        assert.equal(analytics.audience[0]?.donations.RUB, '500');
    }
    finally {
        s.close();
    }
});

test('YouTube messages around a category switch in one minute are split correctly and later messages extend the inference window', () => {
    const s = new StreamStore(':memory:');
    try {
        const sid = recordedStream(s,'channel', 'mid-minute', base, 'platform', base);
        s.streamSample(sid, base, 'game', 'Game', '', null);
        s.streamSample(sid, base + 30000, 'talk', 'Talk', '', null);
        s.youtubeMessages('yt-owner', 'chat', [10000, 40000, 50000].map((offset, n) => ({
            id: `mid-${n}`, snippet: { type: 'textMessageEvent', publishedAt: new Date(base + offset).toISOString() },
            authorDetails: { channelId: 'viewer', displayName: 'Viewer' }
        })));
        s.endSession(sid, end, 'observed');
        const result = s.analytics({ ...opts, source: 'youtube' });
        assert.equal(result.categories.find(x => x.id === 'game')?.messages, 1);
        assert.equal(result.categories.find(x => x.id === 'talk')?.messages, 2);
        assert.equal(result.audience[0]?.intervals[0]?.from, base + 10000);
        assert.equal(result.audience[0]?.intervals[0]?.to, base + 50000 + 5 * minute);
        assert.equal(s.analytics({ ...opts, source: 'youtube', category: 'talk' }).summary.messages, 2);
    } finally { s.close(); }
});

test('renamed bot identities and former channel owners remain excluded without current OAuth tokens', () => {
 const s=new StreamStore(':memory:');
 try {
  const sid=recordedStream(s,'channel','excluded',base,'platform',base);
  s.ensureOwnerIdentity('channel','channel','OwnerOld',base);
  s.recordPoll(sid,'channel',{startedAtMs:base,completedAtMs:base+minute,status:'complete',userIds:['channel','robot','person'],userNames:{channel:'OwnerNew',robot:'jeetbot',person:'Human'}});
  s.updateChatterNames('channel',[{user_id:'robot',user_name:'RobotRenamed'}],base+2*minute);
  const result=s.analytics({fromMs:base,toMs:end});
  assert.deepEqual(result.audience.map(e=>e.name),['Human']);
  assert.equal(s.summary().chatters,1);
  assert.equal(s.persons().filter(p=>!p.is_bot).length,1);
  assert.equal(s.personsTop('observed_minutes',sid).length,1);
 } finally {s.close();}
});

test('empty and missing poll minutes are explicit and category averages use successful coverage only',()=>{
 const s=new StreamStore(':memory:');
 try {
  const sid=recordedStream(s,'channel','coverage',base,'platform',base);
  s.streamSample(sid,base,'game','Game','',12);
  s.recordPoll(sid,'channel',{startedAtMs:base,completedAtMs:base+minute,status:'complete',userIds:['human']});
  s.recordPoll(sid,'channel',{startedAtMs:base+2*minute,completedAtMs:base+3*minute,status:'complete',userIds:[]});
  s.endSession(sid,base+10*minute,'observed');
  const result=s.analytics(opts),cat=result.categories[0] as any;
  assert.equal(result.timeline.length,10);
  assert.equal(result.timeline[4]?.presenceKnown,false);
  assert.equal(cat.observedKnownMinutes,4);
  assert.equal(cat.observedPerKnownMinute,.5);
  assert.equal(cat.coverageRatio,.4);
 } finally {s.close();}
});

test('YouTube bot renames and chat owner flag never turn excluded authors into audience',()=>{
 const s=new StreamStore(':memory:');
 try {
  recordedStream(s,'channel','yt-exclusions',base,'platform',base);
  s.youtubeMessages('yt-owner','chat',[
   {id:'a',snippet:{type:'textMessageEvent',publishedAt:new Date(base+minute).toISOString()},authorDetails:{channelId:'bot-id',displayName:'jeetbot'}},
   {id:'b',snippet:{type:'textMessageEvent',publishedAt:new Date(base+2*minute).toISOString()},authorDetails:{channelId:'bot-id',displayName:'NewName'}},
   {id:'c',snippet:{type:'textMessageEvent',publishedAt:new Date(base+minute).toISOString()},authorDetails:{channelId:'other-owner',displayName:'Owner',isChatOwner:true}},
  ]);
  assert.equal(s.analytics({...opts,fromMs:base+2*minute}).summary.entities,0);
  assert.equal(s.analytics(opts).summary.entities,0);
 }finally{s.close();}
});

test('inference crossing the selected period is clipped without counting messages outside that period',()=>{
 const s=new StreamStore(':memory:');
 try {
  const sid=recordedStream(s,'channel','boundary',base,'platform',base);s.streamSample(sid,base,'game','Game','',null);
  s.youtubeMessages('yt-owner','chat',[{id:'before',snippet:{type:'textMessageEvent',publishedAt:new Date(base+minute).toISOString()},authorDetails:{channelId:'human',displayName:'Human'}}]);
  const result=s.analytics({...opts,fromMs:base+2*minute});
  assert.equal(result.audience[0]?.estimatedChatMinutes,4);
  assert.equal(result.summary.messages,0);
 }finally{s.close();}
});

test('asynchronous YouTube counts retain their actual sample minute rather than rewriting a past Twitch minute',()=>{
 const s=new StreamStore(':memory:');
 try {
  const sid=recordedStream(s,'channel','async-count',base,'platform',base);s.streamSample(sid,base,'game','Game','',12);
  s.youtubeViewers(base+minute,4);
  const result=s.analytics({...opts,source:'youtube'});
  assert.equal(result.timeline.find(x=>x.at===base)?.viewers,null);
  assert.equal(result.timeline.find(x=>x.at===base+minute)?.viewers,4);
  s.youtubeViewers(base+4*minute+1,5);
  assert.equal(s.analytics({...opts,source:'youtube'}).timeline.find(x=>x.at===base+4*minute)?.viewers,null);
 }finally{s.close();}
});

test('unnamed categories and YouTube authors stay readable, while chat outside recorded streams is excluded',()=>{
 const s=new StreamStore(':memory:');
 try {
  const sid=recordedStream(s,'channel','unnamed',base,'platform',base);
  s.streamSample(sid,base,'game','','',null);
  s.streamSample(sid,base+minute,'talk','','',null);
  s.streamSample(sid,base+3*minute,'future','Future','',null);
  s.endSession(sid,base+4*minute,'observed');
  s.youtubeMessages('yt-owner','chat',[{id:'unnamed',snippet:{type:'textMessageEvent',publishedAt:new Date(base+minute).toISOString()},authorDetails:{channelId:'unnamed-author'}},{id:'outside',snippet:{type:'textMessageEvent',publishedAt:new Date(base+10*minute).toISOString()},authorDetails:{channelId:'outside-author'}}]);
  const result=s.analytics({...opts,toMs:base+2*minute});
  assert.equal(result.audience[0]?.name,'unnamed-author');
  assert.ok(result.categories.every(c=>c.name==='Категория неизвестна'));
  assert.equal(s.analytics({...opts,fromMs:base+minute/2,toMs:base+2*minute}).categories[0]?.name,'Категория неизвестна');
  assert.equal(s.analytics(opts).audience.some(e=>e.id==='youtube:outside-author'),false);
  assert.deepEqual(unionSpans([{from:base,to:base+minute,session:sid,kind:'observed'},{from:base,to:base+2*minute,session:sid,kind:'observed'}]),[{from:base,to:base+2*minute,session:sid,kind:'observed'}]);
 } finally {s.close();}
});

test('regular audience uses attendance share, excludes donation-only profiles and stacks only attributable minute signals',()=>{
 const s=new StreamStore(':memory:');
 try {
  for(let n=0;n<3;n++){
   const start=base+n*5*minute,sid=recordedStream(s,'channel',`regular-share-${n}`,start,'platform',start);
   s.streamSample(sid,start,'game','Game','',10);
   const ids=['regular',...(n<2?['two-thirds']:[]),...(n===0?['once']:[]),'owner','bot'];
   s.recordPoll(sid,'channel',{startedAtMs:start,completedAtMs:start+minute,status:'complete',userIds:ids,userNames:{regular:'Regular','two-thirds':'Two thirds',once:'Once',owner:'Owner',bot:'jeetbot'}});
   for(const actor of ['regular',...(n===0?['once']:[])])s.ingest({source:'twitch',accountId:'channel',externalId:`regular-msg-${n}-${actor}`,type:'chat.message',actor:{externalId:actor,displayName:actor},occurredAtMs:start,receivedAtMs:start,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}});
   s.ingest({source:'donationalerts',accountId:'da',externalId:`tip-only-${n}`,type:'donation',actor:{externalId:'name:donor only',displayName:'Donor only'},occurredAtMs:start,receivedAtMs:start,sourceTime:null,timeQuality:'provider',transport:'rest',payload:{amountMinor:'100',currency:'RUB'}});
   s.youtubeMessages('yt-owner','chat',[{id:`regular-yt-${n}`,snippet:{type:'textMessageEvent',publishedAt:new Date(start).toISOString()},authorDetails:{channelId:'regular-yt',displayName:'YT regular'}},...(n===0?[{id:'once-yt',snippet:{type:'textMessageEvent',publishedAt:new Date(start).toISOString()},authorDetails:{channelId:'once-yt',displayName:'YT once'}}]:[])]);
   s.endSession(sid,start+3*minute,'observed');
  }
  const query={...opts,regularThresholdPercent:60},result=s.analytics(query);
  assert.equal(result.summary.regulars,3);assert.equal(result.summary.attendees,5);assert.equal(result.summary.regularShare,.5);
  assert.equal(result.audience.find(e=>e.name==='Two thirds')!.attendanceRatio,2/3);
  assert.equal(result.audience.find(e=>e.name==='Donor only')!.regular,false);
  assert.equal(result.streamComparison[0]!.audience,5);assert.equal(result.streamComparison[0]!.newInPeriod,5);
  assert.equal(result.categories[0]!.audience,5);
  const first=result.timeline.find(p=>p.at===base)!;
  assert.equal(first.observed,3);assert.equal(first.regularObserved,2);
  assert.equal(first.estimated,2);assert.equal(first.regularEstimated,1);
  assert.equal(first.messages,4);assert.equal(first.regularMessages,2);
  assert.equal(s.analytics({...query,regularThresholdPercent:100}).summary.regulars,0);
  assert.equal(s.analytics({...query,regularThresholdPercent:0}).summary.regulars,3);
  const exact=s.analytics({...query,regularThresholdPercent:100*2/3});
  assert.equal(exact.audience.find(e=>e.name==='Two thirds')!.regular,false);
  assert.equal(s.analytics({...query,category:'absent'}).summary.regularShare,null);
  for(const threshold of [-1,101,NaN])assert.throws(()=>s.analytics({...query,regularThresholdPercent:threshold}),/INVALID_ANALYTICS_FILTER/);
 }finally{s.close();}
});

test('switching away and back within one minute never counts a regular attendee twice in that bar',()=>{
 const s=new StreamStore(':memory:');
 try {
  const sid=recordedStream(s,'channel','minute-return',base,'platform',base);
  s.streamSample(sid,base,'game','Game','',2);s.streamSample(sid,base+10000,'talk','Talk','',2);s.streamSample(sid,base+20000,'game','Game','',2);
  s.recordPoll(sid,'channel',{startedAtMs:base,completedAtMs:base+minute,status:'complete',userIds:['human']});
  s.youtubeMessages('yt-owner','chat',[{id:'minute-return',snippet:{type:'textMessageEvent',publishedAt:new Date(base+5000).toISOString()},authorDetails:{channelId:'yt-human',displayName:'Human'}}]);
  s.endSession(sid,base+2*minute,'observed');
  const point=s.analytics({...opts,minSessions:1,minMinutes:0,minMessages:0,category:'game'}).timeline.find(p=>p.at===base)!;
  assert.equal(point.observed,1);assert.equal(point.regularObserved,1);assert.equal(point.estimated,1);assert.equal(point.regularEstimated,1);
 }finally{s.close();}
});

test('stream and category donation efficiency use clipped period durations and keep currencies exact',()=>{
 const s=new StreamStore(':memory:');try{
  const sid=s.observePlatformStream('twitch','channel','rates',base,base,null,'Rates')!;
  s.streamSample(sid,base,'game','Game','Rates',10);s.streamSample(sid,base+minute,'talk','Talk','Rates',20);s.endSession(sid,base+2*minute);
  const person=String(s.createPerson('Supporter').id);
  s.createDonation({personId:person,amount:'10',currency:'RUB',occurredAtMs:base+45000,message:'',sourceName:'Cash'},base+3*minute);
  s.createDonation({personId:person,amount:'1.25',currency:'USD',occurredAtMs:base+75000,message:'',sourceName:'Transfer'},base+3*minute);
  const data=s.analytics({fromMs:base+30000,toMs:base+90000});
  assert.equal(data.hours[0]!.sampleMinutes,1);assert.deepEqual(data.hours[0]!.donationTotals,{RUB:'1000',USD:'125'});assert.deepEqual(data.hours[0]!.donationsPerHourMinor,{RUB:'60000',USD:'7500'});
  const comparison=data.streamComparison[0]!;assert.equal(comparison.durationMs,60000);assert.equal(comparison.donationCount,2);
  assert.deepEqual(comparison.donationTotals,{RUB:'1000',USD:'125'});assert.deepEqual(comparison.donationsPerHourMinor,{RUB:'60000',USD:'7500'});assert.equal(comparison.audience,0);assert.equal(comparison.messagesPerHour,0);
  const game=data.categories.find(c=>c.id==='game')!,talk=data.categories.find(c=>c.id==='talk')!;
  assert.equal(game.minutes,.5);assert.equal(talk.minutes,.5);assert.deepEqual(game.donationsPerHourMinor,{RUB:'120000'});assert.deepEqual(talk.donationsPerHourMinor,{USD:'15000'});
  const filtered=s.analytics({fromMs:base+30000,toMs:base+90000,category:'game'}).streamComparison[0]!;assert.equal(filtered.durationMs,30000);assert.equal(filtered.donationCount,1);assert.deepEqual(filtered.donationsPerHourMinor,{RUB:'120000'});
 }finally{s.close();}
});

test('hourly activity uses the actual clipped YouTube window within a partial minute',()=>{
 const s=new StreamStore(':memory:');try{
  const sid=s.observePlatformStream('youtube','yt-owner','partial-window',base,base,null,'Partial')!;
  s.youtubeMessages('yt-owner','partial-chat',[{id:'partial-message',snippet:{type:'textMessageEvent',publishedAt:new Date(base+45000).toISOString(),displayMessage:'hi'},authorDetails:{channelId:'visitor',displayName:'Visitor'}}]);
  s.endSession(sid,base+minute);
  const data=s.analytics({fromMs:base+30000,toMs:base+minute,youtubeAccount:'yt-owner'});
  assert.equal(data.hours[0]!.sampleMinutes,.5);
  assert.equal(data.hours[0]!.estimated,.25);
  assert.equal(data.hours[0]!.messages,1);
 }finally{s.close();}
});

test('comparison deduplicates linked Twitch/YouTube chatters and exposes independent sample coverage',()=>{
 const s=new StreamStore(':memory:');try{
  const sid=s.observePlatformStream('twitch','channel','metric-stream',base,base,null,'Metrics')!;
  s.observePlatformStream('youtube','yt-owner','metric-video',base,base,null,'Metrics');
  s.streamSample(sid,base,'game','Game','Metrics',10);s.youtubeViewers(base,4,sid);
  s.streamSample(sid,base+minute,'game','Game','Metrics',20);
  const tw=s.ingest({source:'twitch',accountId:'channel',externalId:'metric-tw',type:'chat.message',actor:{externalId:'metric-author',displayName:'Linked'},occurredAtMs:base,receivedAtMs:base,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}});
  s.youtubeMessages('yt-owner','metric-chat',[{id:'metric-yt',snippet:{type:'textMessageEvent',publishedAt:new Date(base).toISOString(),displayMessage:'hello'},authorDetails:{channelId:'metric-author-yt',displayName:'Linked'}}]);
  const yp=s.persons().find(p=>String(p.sources).includes('youtube'))!;
  s.merge(String(yp.id),tw.personId!,s.personRevision(String(yp.id)),s.personRevision(tw.personId!),base+minute);
  s.endSession(sid,base+2*minute);
  const comparison=s.analytics({fromMs:base,toMs:base+2*minute,youtubeAccount:'yt-owner'}).streamComparison[0]!;
  assert.equal(comparison.uniqueChatters,1);assert.equal(comparison.peakChatters,1);assert.equal(comparison.meanChatters,.5);assert.equal(comparison.messages,2);
  assert.equal(comparison.viewers.twitch.mean,15);assert.equal(comparison.viewers.twitch.peak,20);assert.equal(comparison.viewers.twitch.coverageRatio,1);
  assert.equal(comparison.viewers.youtube.mean,4);assert.equal(comparison.viewers.youtube.coverageRatio,.5);
 }finally{s.close();}
});

test('single-stream analytics scopes overlapping recordings and ranks silent attendance across gaps', () => {
 const s=new StreamStore(':memory:');
 try {
  const first=s.startSession('first-channel','single-first',base,'platform',base);
  const other=s.startSession('other-channel','single-other',base,'platform',base);
  s.recordPoll(first,'first-channel',{startedAtMs:base,completedAtMs:base+2*minute,status:'complete',userIds:['silent','talker','streamelements'],userNames:{silent:'Silent',talker:'Talker'}});
  s.recordPoll(first,'first-channel',{startedAtMs:base+3*minute,completedAtMs:base+4*minute,status:'failed',userIds:['silent']});
  s.recordPoll(first,'first-channel',{startedAtMs:base+5*minute,completedAtMs:base+6*minute,status:'complete',userIds:['silent']});
  s.recordPoll(other,'other-channel',{startedAtMs:base,completedAtMs:base+9*minute,status:'complete',userIds:['other'],userNames:{other:'Other'}});
  s.ingest({source:'twitch',accountId:'first-channel',externalId:'single-message',type:'chat.message',actor:{externalId:'talker',displayName:'Talker'},occurredAtMs:base+minute,receivedAtMs:base+minute,timeQuality:'provider',sourceTime:null,transport:'eventsub',payload:{text:'hello'}});
  s.endSession(first,base+10*minute,'observed');s.endSession(other,base+10*minute,'observed');
  const result=s.analytics({...opts,sessionId:first} as any);
  assert.equal(result.summary.streams,1);
  assert.deepEqual(result.audience.map(p=>p.name).sort(),['Silent','Talker']);
  const silent=result.audience.find(p=>p.name==='Silent')!;
  assert.equal(silent.messages,0);assert.equal(silent.observedMinutes,5);
  assert.equal(result.audience.find(p=>p.name==='Talker')!.observedMinutes,3);
  assert.equal(result.timeline.find(p=>p.at===base+3*minute)!.presenceKnown,false);
  assert.deepEqual(result.audience.filter(p=>p.intervals.some(i=>i.from<base+minute&&i.to>base)).map(p=>p.name).sort(),['Silent','Talker']);
  assert.throws(()=>s.analytics({...opts,sessionId:'missing'}),/SESSION_NOT_FOUND/);
 }finally{s.close();}
});
