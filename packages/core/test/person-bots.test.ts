import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {StreamStore} from '../src/store.js';
import {daDonorExternalId} from '../src/domain.js';
import {PersonBots,databaseBotExclusions} from '../src/person-bots.js';
const at=Date.UTC(2026,10,1),minute=60000;
let sequence=0;
function viewer(s:StreamStore,id:string,time=at,name=id){return s.ingest({source:'twitch',accountId:'owner',externalId:`m${++sequence}`,type:'chat.message',actor:{externalId:id,displayName:name},occurredAtMs:time,receivedAtMs:time,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}}).personId!;}
function mark(s:StreamStore,id:string,value=true){return s.setPersonBot(id,value,s.personRevision(id));}
const raw=(s:StreamStore)=>(s as unknown as {db:Database.Database}).db;
function broadcast(s:StreamStore,stream:string,time:number,users:string[]){const id=s.startSession('owner',stream,time,'platform',time);s.streamSample(id,time,'game','Game','',11);for(const user of users)viewer(s,user,time);s.recordPoll(id,'owner',{startedAtMs:time,completedAtMs:time+minute,status:'complete',userIds:users});s.endSession(id,time+2*minute);return id;}

test('manual marks rebuild only affected stream facts, separate both modes and subtract observed bots from online',()=>{
 const s=new StreamStore(':memory:');try{
  const a=broadcast(s,'a',at,['suspect','human']),b=broadcast(s,'b',at+3*minute,['other']);
  const id=s.candidatePersons('suspect')[0]!,q={fromMs:at,toMs:at+5*minute,summaryOnly:true};
  assert.equal(s.analytics(q).summary.attendees,3);
  const before=raw(s).prepare('SELECT session_id,activity FROM analytics_fact_versions ORDER BY session_id').all() as {session_id:string;activity:number}[];
  const bPayload=raw(s).prepare('SELECT payload FROM analytics_stream_facts WHERE session_id=?').get(b);
  const state=mark(s,id);assert.equal(state.manualBot,true);assert.equal(state.canMarkBot,true);
  const after=raw(s).prepare('SELECT session_id,activity FROM analytics_fact_versions ORDER BY session_id').all() as typeof before;
  assert.ok(after.find(x=>x.session_id===a)!.activity>before.find(x=>x.session_id===a)!.activity);
  assert.equal(after.find(x=>x.session_id===b)!.activity,before.find(x=>x.session_id===b)!.activity);
  const clean=s.analytics(q),all=s.analytics({...q,excludedLogins:false});
  assert.equal(clean.summary.attendees,2);assert.equal(all.summary.attendees,3);
  assert.equal(clean.summary.messages,2);assert.equal(all.summary.messages,3);
  assert.equal(all.audience.find(p=>p.id===id)!.is_bot,1);
  assert.equal(clean.streamComparison.find(p=>p.id===a)!.viewers.twitch.mean,9);assert.equal(all.streamComparison.find(p=>p.id===a)!.viewers.twitch.mean,10);assert.equal(all.streamComparison.find(p=>p.id===a)!.botViewers.twitch.mean,1);
  assert.deepEqual(raw(s).prepare('SELECT payload FROM analytics_stream_facts WHERE session_id=?').get(b),bPayload);
  assert.equal(s.analytics(q).summary.attendees,2);
  assert.equal(s.channelOverview().records.peakChat?.value,1);assert.equal(s.channelOverview(false).records.peakChat?.value,2);
  assert.equal(s.summary(a).messages,1);assert.equal(s.summary(a,false).messages,2);
  assert.equal(s.personsPage('',[],0,0,50,'bots').total,1);
  assert.equal(s.personsPage('',[],0,0,50,'all').total,3);
  assert.throws(()=>s.personsPage('',[],0,0,50,'invalid'),/INVALID_BOT_FILTER/);
  assert.equal(s.events(a).find(e=>e.person_id===id)!.is_bot,1);
  mark(s,id,false);assert.equal(s.analytics(q).summary.attendees,3);
  assert.equal(databaseBotExclusions(raw(s),false).size,0);
 }finally{s.close();}
});

test('Twitch-only rule rejects YouTube, owners, donors, stale and malformed writes; donations remove a previous mark',()=>{
 const s=new StreamStore(':memory:');try{
  const sid=broadcast(s,'a',at,['suspect']);const id=s.candidatePersons('suspect')[0]!;
  assert.throws(()=>s.personBot('missing'),/PERSON_NOT_FOUND/);
  assert.throws(()=>s.setPersonBot(id,true,-1),/INVALID_BOT_MARK/);
  assert.throws(()=>s.setPersonBot(id,1 as unknown as boolean,0),/INVALID_BOT_MARK/);
  const old=s.personRevision(id);mark(s,id);assert.throws(()=>s.setPersonBot(id,false,old),/REVISION_CONFLICT/);
  const q={fromMs:at,toMs:at+2*minute,sessionId:sid};assert.equal(s.analytics(q).summary.attendees,0);
  s.createDonation({personId:id,amount:'10',currency:'RUB',occurredAtMs:at,message:'',sourceName:'Manual'},at+1);
  assert.equal(s.personBot(id).manualBot,false);assert.equal(s.personBot(id).isDonor,true);assert.equal(s.personBot(id).canMarkBot,false);
  assert.equal(s.person(id).is_donor,true);assert.equal(s.person(id).is_bot,0);
  assert.equal(s.analytics(q).summary.attendees,1);
  assert.throws(()=>mark(s,id),/BOT_NOT_ELIGIBLE/);mark(s,id,false);
  const owner=viewer(s,'owner');assert.throws(()=>mark(s,owner),/BOT_NOT_ELIGIBLE/);
  s.youtubeMessages('yt-owner','chat',[{id:'yt-message',snippet:{type:'textMessageEvent',publishedAt:new Date(at).toISOString()},authorDetails:{channelId:'yt-user',displayName:'YouTube only'}}]);
  const yt=s.candidatePersons('YouTube only')[0]!;assert.throws(()=>mark(s,yt),/BOT_NOT_ELIGIBLE/);
  const tw=viewer(s,'linked');s.merge(yt,tw,s.personRevision(yt),s.personRevision(tw),at+2);assert.throws(()=>mark(s,tw),/BOT_NOT_ELIGIBLE/);
 }finally{s.close();}
});

test('ID-based exclusions do not hide a different YouTube user with the same nickname',()=>{
 const s=new StreamStore(':memory:');try{
  const sid=broadcast(s,'a',at,['suspect']);const id=s.candidatePersons('suspect')[0]!;
  raw(s).prepare("INSERT INTO platform_streams(session_id,platform,account_id,external_id,started_at_ms,ended_at_ms,last_observed_at_ms,offline_checks,first_missing_at_ms,url,title) VALUES (?,'youtube','yt-owner','video',?,?,?,0,NULL,NULL,'Video')").run(sid,at,at+2*minute,at+minute);
  s.youtubeMessages('yt-owner','chat',[{id:'yt-message',snippet:{type:'textMessageEvent',publishedAt:new Date(at).toISOString()},authorDetails:{channelId:'yt-user',displayName:'suspect'}}]);
  const ytIdentity=(s.person(id).identities as {id:string;source:string}[]).find(i=>i.source==='youtube')!;
  s.splitIdentities([ytIdentity.id],'Separate YouTube',s.personRevision(id),at+3);
  mark(s,id);
  const report=s.analytics({fromMs:at,toMs:at+2*minute,youtubeAccount:'yt-owner'});
  assert.equal(report.summary.attendees,1);assert.equal(report.audience[0]!.sources[0],'youtube');
  assert.equal(s.personsPage('',[],0,0,50,'humans').total,1);
 }finally{s.close();}
});

test('identity-anchored marks survive merge, split, undo and restart while sharing manual decisions across profiles',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-bots-')),path=join(dir,'data.sqlite');let a=new StreamStore(path,'ruslan');const b=new StreamStore(path,'gulnaz');
 try{
  const id=viewer(a,'suspect'),peer=viewer(b,'suspect'),other=viewer(a,'other');mark(a,id);
  assert.equal(b.personBot(peer).manualBot,true);
  b.setPersonHuman(peer,true,b.personRevision(peer));assert.equal(a.personBot(id).manualHuman,true);assert.equal(b.personBot(peer).manualHuman,true);mark(a,id);
  const merge=a.merge(id,other,a.personRevision(id),a.personRevision(other),at+1);
  assert.equal(a.personBot(other).manualBot,true);
  a.undoMerge(merge,at+2);assert.equal(a.personBot(id).manualBot,true);assert.equal(a.personBot(other).manualBot,false);
  a.close();a=new StreamStore(path,'ruslan');assert.equal(a.personBot(id).manualBot,true);
  const identity=(a.person(id).identities as {id:string}[])[0]!;
  a.splitIdentities([identity.id],'Split',a.personRevision(id),at+3);
  const destination=raw(a).prepare('SELECT person_id FROM identities WHERE id=?').get(identity.id) as {person_id:string};
  assert.equal(a.personBot(destination.person_id).manualBot,true);
  a.undoSplit(String(a.splits()[0]!.id),at+4);assert.equal(a.personBot(id).manualBot,true);
  const bot=new PersonBots(raw(a));assert.equal(bot.decorate([{id:null}],p=>p.id)[0]!.is_bot,0);
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

test('manual human marks replace audience bot marks but never unhide service accounts',()=>{
 const s=new StreamStore(':memory:');try{
  const sid=broadcast(s,'a',at,['suspect','nightbot']);const id=s.candidatePersons('suspect')[0]!,known=s.candidatePersons('nightbot')[0]!;
  const q={fromMs:at,toMs:at+2*minute,sessionId:sid};mark(s,id);assert.equal(s.analytics(q).summary.attendees,0);
  const stale=s.personRevision(id);s.setPersonHuman(id,true,stale);
  assert.equal(s.personBot(id).manualHuman,true);assert.equal(s.personBot(id).manualBot,false);assert.equal(s.person(id).is_human,true);
  assert.equal(s.analytics(q).summary.attendees,1);assert.equal(s.summary(sid).messages,1);
  assert.throws(()=>s.setPersonHuman(id,false,stale),/REVISION_CONFLICT/);
  assert.throws(()=>s.setPersonHuman(id,'true' as unknown as boolean,s.personRevision(id)),/INVALID_HUMAN_MARK/);
  assert.throws(()=>s.setPersonHuman(id,true,-1),/INVALID_HUMAN_MARK/);
  s.setPersonHuman(known,true,s.personRevision(known));assert.equal(s.analytics(q).summary.attendees,1);assert.equal(s.summary(sid).messages,1);
  assert.equal(s.personsPage('',[],0,0,50,'bots').total,0);
  s.setPersonHuman(known,false,s.personRevision(known));assert.equal(s.analytics(q).summary.attendees,1);
  mark(s,id);assert.equal(s.personBot(id).manualHuman,false);assert.equal(s.personBot(id).manualBot,true);
  s.setPersonHuman(id,false,s.personRevision(id));assert.equal(s.personBot(id).manualBot,true);
 }finally{s.close();}
});

test('YouTube and DonationAlerts accounts automatically establish humanity even without donations; unlinked cards support manual humans',()=>{
 const s=new StreamStore(':memory:');try{
  const card=String(s.createPerson('Known person').id);s.setPersonHuman(card,true,s.personRevision(card));assert.equal(s.person(card).is_human,true);
  s.setPersonHuman(card,false,s.personRevision(card));assert.equal(s.person(card).is_human,false);
  const target=viewer(s,'target');s.setPersonHuman(card,true,s.personRevision(card));
  const carrier=viewer(s,'carrier');raw(s).prepare('UPDATE identities SET person_id=? WHERE person_id=?').run(card,carrier);
  const merge=s.merge(card,target,s.personRevision(card),s.personRevision(target),at+1);assert.equal(s.person(target).is_human,true);
  s.undoMerge(merge,at+2);assert.equal(s.person(card).is_human,true);assert.equal(s.person(target).is_human,false);
  const donor=s.ingest({source:'donationalerts',accountId:'da',externalId:'connected',type:'channel.follow',actor:{externalId:daDonorExternalId('DA account'),displayName:'DA account'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'rest',payload:{}}).personId!;
  assert.equal(s.personBot(donor).automaticHuman,true);assert.equal(s.personBot(donor).isDonor,false);assert.equal(s.person(donor).is_human,true);
  s.youtubeMessages('yt','chat',[{id:'yt',snippet:{type:'textMessageEvent',publishedAt:new Date(at).toISOString()},authorDetails:{channelId:'human',displayName:'YT account'}}]);
  const yt=s.candidatePersons('YT account')[0]!;assert.equal(s.personBot(yt).automaticHuman,true);assert.equal(s.person(yt).is_human,true);
  s.setPersonHuman(yt,false,s.personRevision(yt));assert.equal(s.personBot(yt).automaticHuman,true);
 }finally{s.close();}
});

test('rolling-core minute-boundary warming cannot hide current-minute chat in a live report',t=>{
 const now=at+10*minute+30000;t.mock.method(Date,'now',()=>now);
 const s=new StreamStore(':memory:');try{
  const sid=s.startSession('owner','live',at,'platform',at);s.streamSample(sid,at,'game','Game','',11);
  const id=viewer(s,'current',now-5000),q={sessionId:sid,fromMs:0,toMs:Math.floor(now/minute)*minute};
  assert.equal(s.analytics(q).summary.messages,0);
  assert.equal(s.analytics({...q,toMs:now}).summary.messages,1);
  assert.equal(s.analytics(q).summary.messages,0);
  s.setPersonHuman(id,true,s.personRevision(id));
  const report=s.analytics({...q,toMs:now,rollingCore:true});assert.equal(report.summary.messages,1);assert.equal(report.audience[0]!.is_human,true);
 }finally{s.close();}
});

test('three-state classification switches and clears both flags atomically with eligibility and revision checks',()=>{
 const s=new StreamStore(':memory:');try{
  const id=viewer(s,'switch');
  const choose=(kind:'bot'|'unknown'|'human')=>s.setPersonClassification(id,kind,s.personRevision(id));
  assert.equal(choose('bot').manualBot,true);
  assert.equal(choose('human').manualBot,false);assert.equal(s.personBot(id).manualHuman,true);
  assert.equal(choose('unknown').manualHuman,false);assert.equal(s.personBot(id).manualBot,false);
  choose('bot');assert.equal(choose('unknown').manualBot,false);
  const stale=s.personRevision(id);choose('human');assert.throws(()=>s.setPersonClassification(id,'bot',stale),/REVISION_CONFLICT/);
  assert.throws(()=>s.setPersonClassification(id,'invalid' as 'bot',s.personRevision(id)),/INVALID_PERSON_CLASSIFICATION/);
  assert.throws(()=>s.setPersonClassification(id,'unknown',-1),/INVALID_PERSON_CLASSIFICATION/);
  s.createDonation({personId:id,amount:'1',currency:'RUB',occurredAtMs:at,message:'',sourceName:'Manual'},at);
  assert.throws(()=>choose('bot'),/INVALID_AUTOMATIC_CLASSIFICATION/);assert.throws(()=>choose('unknown'),/INVALID_AUTOMATIC_CLASSIFICATION/);
  assert.equal(choose('human').automaticHuman,true);
 }finally{s.close();}
});

test('neutral explicitly clears detected bot coloring and cached exclusions, including custom bot names',()=>{
 const s=new StreamStore(':memory:');try{
  const sid=broadcast(s,'known-bots',at,['nightbot','custombot']),known=s.candidatePersons('nightbot')[0]!,custom=s.candidatePersons('custombot')[0]!;
  const q={sessionId:sid,fromMs:at,toMs:at+2*minute,excludedLogins:['custombot']};
  assert.equal(s.personBot(known).knownBot,true);assert.equal(s.personBot(custom,['custombot']).knownBot,true);
  assert.equal(s.analytics(q).summary.attendees,0);
  s.setPersonClassification(known,'unknown',s.personRevision(known));assert.equal(s.personBot(known).knownBot,false);assert.equal(s.person(known).is_bot,0);
  assert.equal(s.analytics(q).summary.attendees,0);assert.equal(s.summary(sid,['custombot']).messages,0);
  s.setPersonClassification(custom,'unknown',s.personRevision(custom));assert.equal(s.personBot(custom,['custombot']).knownBot,false);
  assert.equal(s.analytics(q).summary.attendees,1);assert.equal(s.personsPage('', ['custombot'],0,0,50,'bots').total,0);
  s.setPersonClassification(known,'bot',s.personRevision(known));assert.equal(s.person(known).is_bot,1);assert.equal(s.analytics(q).summary.attendees,1);
 }finally{s.close();}
});


test('classification changes preserve personal message and presence history',()=>{
 const s=new StreamStore(':memory:');try{
  broadcast(s,'history',at,['viewer']);const id=s.candidatePersons('viewer')[0]!;
  const before=s.personStats(id);assert.ok(Number(before.totalObservedMinutes)>0);assert.ok(Number(before.messageCount)>0);
  for(const kind of ['bot','human','unknown'] as const){s.setPersonClassification(id,kind,s.personRevision(id));const after=s.personStats(id);assert.equal(after.totalObservedMinutes,before.totalObservedMinutes);assert.equal(after.messageCount,before.messageCount);assert.equal(after.sessionsWithAttendance,before.sessionsWithAttendance);}
 }finally{s.close();}
});
