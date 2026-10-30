import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';

const at=Date.UTC(2026,9,30,12),minute=60000;
const message=(id:string,author:string,name:string,time=at)=>({id,snippet:{type:'textMessageEvent',publishedAt:new Date(time).toISOString()},authorDetails:{channelId:author,displayName:name}});
function twitch(s:StreamStore,account:string,id:string,user:string,name:string,time=at){
  return s.ingest({source:'twitch',accountId:account,externalId:id,type:'chat.message',actor:{externalId:user,displayName:name},occurredAtMs:time,receivedAtMs:time,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{}}).personId!;
}

test('renamed Twitch and YouTube owners stay excluded in their profile and remain viewers in the other profile',()=>{
  for(const profile of ['ruslan','gulnaz']){
    const s=new StreamStore(':memory:',profile);
    const owner=profile==='ruslan'?'ruslan-id':'gulnaz-id';
    const ytOwner=profile==='ruslan'?'ruslan-yt':'gulnaz-yt';
    try{
      const sid=s.observePlatformStream('twitch',owner,'stream',at,at,null,'Stream')!;
      s.observePlatformStream('youtube',ytOwner,'video',at,at,null,'Stream');
      s.ensureOwnerIdentity(owner,owner,profile==='ruslan'?'Fullrandomname_twitch':'AmaliaMelina',at);
      const ruslan=twitch(s,owner,'before','ruslan-id','Fullrandomname_twitch');
      const gulnaz=twitch(s,owner,'gulnaz','gulnaz-id','AmaliaMelina');
      s.youtubeMessages(ytOwner,'chat',[message('yt-before','ruslan-yt','Fullrandomname'),message('yt-gulnaz','gulnaz-yt','GulnazYouTube')]);
      const ytRuslan=String(s.persons().find(p=>(s.person(String(p.id)).identities as any[]).some(i=>i.source==='youtube'&&i.external_id==='ruslan-yt'))!.id);
      s.merge(ytRuslan,ruslan,s.personRevision(ytRuslan),s.personRevision(ruslan),at);
      s.ensureOwnerIdentity(owner,owner,profile==='ruslan'?'rlod':'AmaliaMelina',at+minute);
      assert.equal(twitch(s,owner,'after','ruslan-id','rlod',at+minute),ruslan);
      s.youtubeMessages(ytOwner,'chat',[message('yt-after','ruslan-yt','rlod_yt',at+minute)]);
      s.recordPoll(sid,owner,{startedAtMs:at,completedAtMs:at+2*minute,status:'complete',userIds:['ruslan-id','gulnaz-id']});
      s.endSession(sid,at+3*minute);
      const ownerPerson=profile==='ruslan'?ruslan:gulnaz,guest=profile==='ruslan'?gulnaz:ruslan;
      assert.equal(s.personStats(ownerPerson,sid).messageCount,0,profile);
      assert.ok(Number(s.personStats(guest,sid).messageCount)>0,profile);
      const options={fromMs:at,toMs:at+3*minute,ownerId:owner,youtubeAccount:ytOwner};
      const audience=s.analytics(options).audience;
      assert.ok(!audience.some(p=>p.id===ownerPerson),profile);
      assert.ok(audience.some(p=>p.id===guest),profile);
      assert.ok(!s.persons().filter(p=>!p.is_bot).some(p=>p.id===ownerPerson),profile);
      assert.equal(s.eventCount(),3,'provider facts survive owner exclusion');
      assert.equal(s.youtubeData(ytOwner).messages.length,3);
      assert.deepEqual(s.candidatePersons('Fullrandomname_twitch'),[ruslan]);
      assert.deepEqual(s.candidatePersons('rlod'),[ruslan]);
      assert.deepEqual(s.candidatePersons('Fullrandomname'),[ruslan]);
      assert.deepEqual(s.candidatePersons('rlod_yt'),[ruslan]);
    }finally{s.close();}
  }
});

test('provider renames update automatic card names while preserving explicit group names and stable IDs',()=>{
  const s=new StreamStore(':memory:');
  try{
    const owner=s.ensureOwnerIdentity('owner','owner','Fullrandomname_twitch',at);
    assert.equal(s.ensureOwnerIdentity('owner','owner','rlod',at+minute),owner);
    assert.equal(s.person(owner).display_name,'rlod');
    // Persisted state produced by earlier releases: new identity, old card name.
    s.renamePerson(owner,'Fullrandomname_twitch');
    s.ensureOwnerIdentity('owner','owner','rlod',at+minute);
    assert.equal(s.person(owner).display_name,'rlod');
    s.renamePerson(owner,'Руслан');
    s.ensureOwnerIdentity('owner','owner','rlod_next',at+2*minute);
    assert.equal(s.person(owner).display_name,'Руслан');
    s.youtubeMessages('channel','chat',[message('1','yt-author','Fullrandomname')]);
    const yt=String(s.persons().find(p=>p.id!==owner)!.id);
    s.youtubeMessages('channel','chat',[message('2','yt-author','rlod_yt',at+minute)]);
    assert.equal(s.person(yt).display_name,'rlod_yt');
    s.renamePerson(yt,'Fullrandomname');
    s.youtubeMessages('channel','chat',[message('2b','yt-author','rlod_yt',at+minute)]);
    assert.equal(s.person(yt).display_name,'rlod_yt');
    s.renamePerson(yt,'YouTube group');
    s.youtubeMessages('channel','chat',[message('3','yt-author','NextName',at+2*minute)]);
    assert.equal(s.person(yt).display_name,'YouTube group');
    assert.deepEqual(s.candidatePersons('Fullrandomname'),[yt]);
    assert.equal(s.persons().length,2);
  }finally{s.close();}
});

test('validated Twitch login repairs completed channel links without changing broadcast facts, VODs or other accounts',()=>{
  const s=new StreamStore(':memory:');
  try{
    const cases:[string,string,string][]=[
      ['owner','old','https://www.twitch.tv/Fullrandomname_twitch'],
      ['owner','slash','https://twitch.tv/Fullrandomname_twitch/'],
      ['owner','vod','https://www.twitch.tv/Fullrandomname_twitch/videos/123'],
      ['other','other','https://www.twitch.tv/Fullrandomname_twitch'],
    ];
    const ids=cases.map(([account,id,url],i)=>{
      const start=at-(10-i)*86400000;
      const sid=s.observePlatformStream('twitch',account,id,start,start,url,'Saved title')!;
      s.endSession(sid,start+minute);return sid;
    });
    const yt=s.observePlatformStream('youtube','yt-owner','video',at,at,'https://www.youtube.com/watch?v=video','YouTube')!;
    s.endSession(yt,at+minute);
    const before=ids.map(id=>s.platformStreams(id)[0]!);
    const owner=s.ensureOwnerIdentity('owner','owner','Fullrandomname_twitch',at);
    s.ensureOwnerIdentity('owner','owner','rlod',at+12*minute,'rlod');
    s.ensureOwnerIdentity('owner','owner','rlod',at+13*minute,'rlod');
    for(const [i,id] of ids.entries()){
      const expected=i<2?'https://www.twitch.tv/rlod':cases[i]![2];
      assert.deepEqual(s.platformStreams(id)[0],{...before[i],url:expected});
      assert.deepEqual(s.sessions(id)[0]!.confirmedUrls,[{platform:'twitch',url:expected}]);
    }
    assert.equal(s.platformStreams(yt)[0]!.url,'https://www.youtube.com/watch?v=video');
    assert.throws(()=>s.ensureOwnerIdentity('owner','owner','bad',at+14*minute,'bad/path'),/INVALID_TWITCH_LOGIN/);
    assert.equal(s.person(owner).display_name,'rlod','invalid link update rolls back the name change');
    s.ensureOwnerIdentity('other','guest','Guest',at+14*minute,'guest');
    assert.equal(s.platformStreams(ids[3]!)[0]!.url,cases[3]![2]);
  }finally{s.close();}
});
