import test from 'node:test';import assert from 'node:assert/strict';import {StreamStore} from '../src/store.js';
test('opening an old stream reads that stream beyond the latest 100 and compact totals agree with full totals',()=>{
 const store=new StreamStore(':memory:');try{
  const start=1790000000000,first=store.startSession('owner','old',start,'platform',start);
  store.ingest({source:'twitch',accountId:'owner',externalId:'old-message',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:start+1000,receivedAtMs:start+1000,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'Old stream'}});
  store.endSession(first,start+60000);
  for(let n=1;n<=101;n++){const at=start+n*120000,id=store.startSession('owner',String(n),at,'platform',at);store.streamSample(id,at,'g','Game','Stream',((value:number|null)=>value===null||value<=0?value:value+1)(n));store.endSession(id,at+60000);}
  assert.equal(store.sessions().length,100);assert.ok(!store.sessions().some(row=>row.id===first));assert.equal(store.sessions(first)[0]!.id,first);assert.deepEqual(store.sessions('missing'),[]);
  const full=store.summary(first),compact=store.summary(first,[],false);for(const key of ['messages','donations','totals','events'])assert.deepEqual(compact[key],full[key]);assert.equal(compact.messages,1);assert.equal(store.summary(undefined,[],false).messages,1);
 }finally{store.close();}
});

test('stream analytics classifies only relevant people and retains silent viewers, chatters, donors and YouTube lookback',async()=>{
 const {audienceAnalytics}=await import('../src/analytics.js');
 const store=new StreamStore(':memory:');
 try{
  const at=Date.now()-86400000,minute=60000,id=store.startSession('owner','scoped',at,'platform',at);
  store.attachPlatformStream(id,'youtube','yt-owner','video',at,at,null,'Video');
  store.recordPoll(id,'owner',{startedAtMs:at,completedAtMs:at+minute,status:'complete',userIds:['silent','streamelements']});
  const message=store.ingest({source:'twitch',accountId:'owner',externalId:'chat',type:'chat.message',actor:{externalId:'chatter',displayName:'Chatter'},occurredAtMs:at+minute,receivedAtMs:at+minute,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'Hello'}});
  store.createDonation({personId:message.personId!,amount:'10',currency:'RUB',occurredAtMs:at+minute,message:'Tip',sourceName:'Cash'},at+minute);
  store.youtubeMessages('yt-owner','chat',[{id:'yt',snippet:{type:'textMessageEvent',publishedAt:new Date(at+minute).toISOString()},authorDetails:{channelId:'yt-viewer',displayName:'YouTube Viewer'}}]);
  store.endSession(id,at+3*minute);
  const db=(store as any).db,insert=db.prepare('INSERT INTO persons(id,display_name) VALUES(?,?)');
  db.transaction(()=>{for(let i=0;i<2000;i++)insert.run('unrelated'+i,'Unrelated '+i);})();
  const reads=(store as any).reads;let classified=0;
  const observed=new Proxy(reads,{get(target,property){
   if(property==='prepare')return(sql:string)=>{
    const statement=target.prepare(sql);
    if(!sql.startsWith('SELECT p.id,p.display_name FROM persons p WHERE'))return statement;
    return new Proxy(statement,{get(target,property){if(property==='all')return(...args:unknown[])=>{const rows=target.all(...args);classified+=rows.length;return rows;};const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});
   };
   const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
  }});
  const options={sessionId:id,fromMs:0,toMs:at+3*minute,youtubeAccount:'yt-owner',ownerId:'owner'};
  const report=audienceAnalytics(observed,options);
  assert.deepEqual(report.audience.map(p=>p.name).sort(),['Chatter','YouTube Viewer','silent']);
  assert.equal(report.summary.messages,2);assert.deepEqual(report.audience.find(p=>p.name==='Chatter')!.donations,{RUB:'1000'});
  assert.equal(classified,3,'unrelated profile people must not be materialized for a stream');
  const clip=audienceAnalytics(observed,{...options,fromMs:at+2*minute});
  assert.ok(clip.audience.find(p=>p.name==='YouTube Viewer')!.estimatedChatMinutes>0,'YouTube messages before the clip still contribute proxy activity');
 }finally{store.close();}
});
