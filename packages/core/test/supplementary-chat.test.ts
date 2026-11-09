import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
import {SupplementaryChat} from '../src/supplementary-chat.js';
const msg=(id:string,author:string,at:number,name=author)=>({id,snippet:{type:'textMessageEvent',publishedAt:new Date(at).toISOString(),displayMessage:id},authorDetails:{channelId:author,displayName:name}});
test('supplementary names, recent events and live authors are visible without changing primary analytical facts',(t)=>{
 const s=new StreamStore(':memory:');const now=Date.now(),start=now-120000;t.mock.method(Date,'now',()=>now);
 try{
  const id=s.observePlatformStream('youtube','primary','main-video',start,start,null,'Primary')!;
  s.youtubeMessages('primary','main-chat',[msg('main','main-viewer',start+1000)]);
  s.youtubeSnapshot('primary','channel',{statistics:{subscriberCount:'20'}},now);
  s.youtubeViewers(now-1000,12,id);
  const options={sessionId:id,fromMs:0,toMs:now,youtubeAccount:'primary'};
  const before=s.analytics(options),summary=s.summary(),cards=s.sessions();
  s.youtubeSnapshot('secondary','collectionRole','secondary',now);
  s.youtubeSnapshot('secondary','broadcasts',[{id:'extra-video',snippet:{liveChatId:'extra-chat'}}],now);
  s.youtubeMessages('secondary','extra-chat',[msg('extra','extra-viewer',now-1000),msg('shared','main-viewer',now-500),msg('old','too-old',start-1000)] ,'extra-video');
  assert.deepEqual(s.analytics(options),before);assert.deepEqual(s.summary(),summary);assert.deepEqual(s.sessions(),cards);
  const participants=s.supplementaryParticipants(id,[],now);assert.equal(participants.length,2);assert.equal(participants[0]!.id,'youtube:main-viewer');
  const live=s.currentChat(id,[],false,now);assert.equal(live.people.length,2);
  assert.equal(live.people.find(p=>p.personId==='youtube:main-viewer')!.messages,2);
  assert.equal(live.people.find(p=>p.personId==='youtube:extra-viewer')!.youtubeSecondary,true);
  const recent=s.recentEvents(0,100,{session:id});assert.equal(recent.length,3);assert.equal(recent.find(p=>p.external_id==='extra')!.youtubeSecondary,1);
  assert.equal(s.recentEvents(0,100,{person:'youtube:extra-viewer',messagesOnly:true}).length,1);
  const page=s.personsPage('',[],0,0,50,'all');assert.equal(page.items.find(p=>p.id==='youtube:extra-viewer')!.youtubeSecondary,true);
  assert.equal(s.person('youtube:main-viewer').youtubeSecondary,false);
  const query=new SupplementaryChat((s as any).db);
  assert.equal(query.participants(id,'[]',now+200000,true).length,0);
  s.youtubeSnapshot('secondary','broadcasts',[],now);assert.equal(s.currentChat(id,[],false,now+1).people.length,1);
  s.endSession(id,now);assert.equal(s.currentChat(id,[],false,now+1).people.length,0);
  s.deleteSession(id,now+2);assert.equal(s.supplementaryParticipants(id,[],now+2).length,0);
 }finally{s.close();}
});
test('supplementary lists exclude owners and bots, respect manual intervals and preserve optional inclusion',()=>{
 const s=new StreamStore(':memory:');const now=Date.now();try{
  const id=s.startSession('local','manual',now-60000,'manual',now-60000);
  s.youtubeSnapshot('second','collectionRole','secondary',now);
  s.youtubeMessages('second','chat',[msg('bot','bot',now-1000),{...msg('owner','second',now-1000),authorDetails:{channelId:'second',displayName:'Owner',isChatOwner:true}},msg('viewer','normal',now-1000)]);
  assert.equal(s.supplementaryParticipants(id,['owner:youtube:bot'],now).length,1);
  assert.equal(new SupplementaryChat((s as any).db).participants(id,'["bot"]',now,false,true).length,3);
  s.deleteSession(id,now);assert.equal(s.supplementaryParticipants(id,[],now).length,0);
 }finally{s.close();}
});
test('supplementary chat excludes merged breaks and keeps profile-specific roles after reopening',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'supplementary-profiles-')),path=join(dir,'db.sqlite'),now=Date.now(),at=now-600000;
 let a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz');
 try{
  const first=a.startSession('owner','first',at,'platform',at);a.endSession(first,at+60000);
  const last=a.startSession('owner','last',at+120000,'platform',at+120000);a.endSession(last,at+180000);a.mergeSessions([first,last]);
  a.youtubeSnapshot('extra','collectionRole','secondary',now);a.youtubeMessages('extra','chat',[msg('first','inside',at+1000),msg('break','pause',at+90000),msg('last','inside',at+121000)]);
  const other=b.observePlatformStream('youtube','extra','other',at,at,null,'Other')!;b.youtubeMessages('extra','chat',[msg('other','other-viewer',at+1000)]);
  assert.equal(a.supplementaryParticipants(last,[],now).length,1);assert.equal(a.supplementaryParticipants(first,[],now)[0]!.messages,2);
  assert.equal(b.supplementaryParticipants(other,[],now).length,0);assert.equal(b.summary(other).messages,1);
  a.close();b.close();a=new StreamStore(path,'ruslan');b=new StreamStore(path,'gulnaz');
  assert.equal(a.supplementaryParticipants(first,[],now)[0]!.messages,2);assert.equal(b.person('youtube:other-viewer').youtubeSecondary,false);
 }finally{a.close();b.close();await rm(dir,{recursive:true,force:true});}
});

test('supplementary requests cannot spend the primary local quota reserve',()=>{
 const s=new StreamStore(':memory:');try{
  assert.equal(s.youtubeQuota('11/09/2026','ruslan:secondary',1000,1000),true);
  assert.equal(s.youtubeQuota('11/09/2026','ruslan:secondary',1,1000),false);
  assert.equal(s.youtubeQuota('11/09/2026','ruslan',4000),true);
  assert.throws(()=>s.youtubeQuota('11/09/2026','ruslan',1,0),/INVALID_QUOTA/);
  assert.throws(()=>s.youtubeQuota('11/09/2026','ruslan',1,4001),/INVALID_QUOTA/);
 }finally{s.close();}
});
