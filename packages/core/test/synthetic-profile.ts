import type Database from 'better-sqlite3';
import type {StreamStore} from '../src/store.js';
import {daDonorExternalId,type EventInput} from '../src/domain.js';

/** Small deterministic PRNG (mulberry32) so the synthetic profile is identical on every run. */
export function seeded(seed:number){
 let a=seed>>>0;
 return ()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
}
export const SYNTHETIC_START=Date.UTC(2026,9,1,15);
export const SYNTHETIC_END=SYNTHETIC_START+16*86400000;
const minute=60000,day=86400000;
const categories=[['game-a','Game A'],['game-b','Game B'],['talk','Just Chatting']] as const;
/**
 * A synthetic two-platform profile with regulars, casual viewers, bots, owner messages, polls with gaps
 * and failures, category switches, YouTube interruptions, donations, follows, moderation, followers,
 * tags, manual core marks, a person merge, a merged stream and a live stream at the end.
 */
export function syntheticProfile(store:StreamStore,seed=7){
 const random=seeded(seed),int=(lo:number,hi:number)=>lo+Math.floor(random()*(hi-lo+1)),chance=(p:number)=>random()<p;
 const twitch=Array.from({length:24},(_,i)=>({id:`tw${i}`,name:i===3?'Аноним':`Viewer${i}`,attend:i<6?.95:i<12?.6:.2,chat:i<4?.25:i<10?.08:.02,silent:i===5||i===11}));
 const twitchBots=[{id:'bot-jeet',name:'jeetbot'},{id:'bot-night',name:'Nightbot'}];
 const youtube=Array.from({length:14},(_,i)=>({id:`UCyt${i}`,name:i===2?'Viewer1':`Tube${i}`,chat:i<3?.4:.08}));
 let message=0;
 const event=(input:Omit<EventInput,'sourceTime'|'timeQuality'|'transport'|'receivedAtMs'>&Partial<EventInput>)=>store.ingest({sourceTime:null,timeQuality:'provider',transport:'eventsub',receivedAtMs:input.occurredAtMs??SYNTHETIC_START,...input} as EventInput);
 const chat=(at:number,user:{id:string;name:string},origin?:string)=>event({source:'twitch',accountId:'channel',externalId:`m${++message}`,type:'chat.message',actor:{externalId:user.id,displayName:user.name},occurredAtMs:at,payload:{text:'hi',...(origin?{originChannelId:origin}:{})}});
 const sessions:string[]=[];
 for(let k=0;k<9;k++){
  const start=SYNTHETIC_START+Math.floor(k*1.7*day)+int(0,240)*minute,length=int(45,130)*minute,live=k===8,end=start+length;
  const sid=store.startSession('channel',`stream-${k}`,start,'platform',start);sessions.push(sid);
  store.observePlatformStream('twitch','channel',`tw-${k}`,start,start,`https://twitch.tv/videos/${k}`,`Stream ${k}`);
  const youtubeOn=k%4!==1,youtubeStart=start+int(0,6)*minute,breakAt=k%3===0?start+Math.floor(length/2):null,resume=breakAt===null?null:breakAt+int(3,9)*minute;
  if(youtubeOn)store.observePlatformStream('youtube','yt-owner',`video-${k}`,youtubeStart,youtubeStart,`https://www.youtube.com/watch?v=video-${k}`,`Stream ${k}`);
  let category=categories[k%3]!,present=new Set<string>();
  for(let at=start;at<(live?start+length/2:end);at+=minute){
   const offset=(at-start)/minute;
   if(breakAt!==null&&at===breakAt&&youtubeOn)store.platformMissing('youtube','yt-owner',[],at);
   if(resume!==null&&at===resume&&youtubeOn)store.observePlatformStream('youtube','yt-owner',`video-${k}-b`,at,at,`https://www.youtube.com/watch?v=video-${k}-b`,`Stream ${k} again`);
   if(offset%37===20&&chance(.7)){category=categories[int(0,2)]!;event({source:'twitch',accountId:'channel',externalId:`cu-${k}-${offset}`,type:'channel.update',actor:null,occurredAtMs:at,payload:{categoryId:category[0],categoryName:category[1],title:`Stream ${k}: ${category[1]}`}});}
   if(offset%5===0)store.streamSample(sid,at,category[0],category[1],`Stream ${k}`,chance(.1)?null:int(3,40));
   if(youtubeOn&&offset%5===2)store.youtubeViewers(at,chance(.15)?null:int(0,12),sid);
   for(const user of twitch){if(!present.has(user.id)&&chance(user.attend/8))present.add(user.id);else if(present.has(user.id)&&chance(.03))present.delete(user.id);}
   if(offset%2===0){
    const status=chance(.06)?'failed':'complete';
    if(!(offset>30&&offset<36&&k%2===0))store.recordPoll(sid,'channel',{startedAtMs:at,completedAtMs:at+int(20,55)*1000,status,userIds:[...present,...(offset%6===0?twitchBots.map(b=>b.id):[]),...(offset%10===0?['owner']:[])]});
   }
   for(const user of twitch)if(present.has(user.id)&&!user.silent&&chance(user.chat))chat(at+int(0,59)*1000,user);
   if(chance(.1))chat(at+5000,twitchBots[int(0,1)]!);
   if(chance(.05))chat(at+7000,{id:'owner',name:'Owner'});
   if(chance(.02))chat(at+9000,{id:'tw0',name:'Viewer0'},'other-channel');
   if(youtubeOn&&chance(.35)){
    const items=youtube.filter(u=>chance(u.chat)).map((u,i)=>({id:`yt-${k}-${offset}-${i}`,snippet:{type:chance(.05)?'superChatEvent':'textMessageEvent',publishedAt:new Date(at+int(0,59)*1000).toISOString(),displayMessage:'hello'},authorDetails:{channelId:u.id,displayName:u.name}}));
    if(chance(.1))items.push({id:`yt-owner-${k}-${offset}`,snippet:{type:'textMessageEvent',publishedAt:new Date(at).toISOString(),displayMessage:'owner'},authorDetails:{channelId:'yt-owner',displayName:'Owner',isChatOwner:true} as any});
    if(chance(.1))items.push({id:`yt-se-${k}-${offset}`,snippet:{type:'textMessageEvent',publishedAt:new Date(at).toISOString(),displayMessage:'!cmd'},authorDetails:{channelId:'UCse',displayName:'StreamElements'}});
    if(items.length)store.youtubeMessages('yt-owner',`chat-${k}`,items,`video-${k}`);
   }
   if(chance(.04)){const donor=chance(.3)?'Аноним':['Patron','Viewer1','Generous','Viewer4'][int(0,3)]!;event({source:'donationalerts',accountId:'da',externalId:`d-${k}-${offset}`,type:'donation',actor:{externalId:daDonorExternalId(donor),displayName:donor},occurredAtMs:at+int(0,59)*1000,transport:'rest',payload:{amountMinor:String(int(1,50)*1000),currency:'RUB',actorName:donor}});}
   if(chance(.015)){const user=twitch[int(12,23)]!;event({source:'twitch',accountId:'channel',externalId:`f-${k}-${offset}`,type:'follow',actor:{externalId:user.id,displayName:user.name},occurredAtMs:at,payload:{}});}
   if(chance(.015))event({source:'twitch',accountId:'channel',externalId:`del-${k}-${offset}`,type:'chat.message_delete',actor:null,occurredAtMs:at+30000,payload:{targetMessageId:`m${message}`,targetUserId:''}});
  }
  if(!live){if(youtubeOn)store.platformMissing('youtube','yt-owner',[],end);store.endSession(sid,end,'observed');}
 }
 store.followingSnapshot('twitch','channel',twitch.filter((_,i)=>i%3===0).map(u=>({id:u.id,name:u.name,followedAtMs:SYNTHETIC_START-day})),true,SYNTHETIC_START+3*day,10);
 store.followingSnapshot('youtube','yt-owner',youtube.filter((_,i)=>i%4===1).map(u=>({id:u.id,name:u.name,followedAtMs:null})),false,SYNTHETIC_START+3*day,null);
 const person=(external:string)=>((store as unknown as {reads:Database.Database}).reads.prepare("SELECT person_id AS id FROM identities WHERE external_id=? UNION ALL SELECT person_id FROM youtube_identities WHERE external_id=? LIMIT 1").get(external,external) as {id:string}|undefined)?.id;
 const meta=(external:string,tags:string[],core:boolean|null)=>{const id=person(external);if(id)store.setPersonMetadata(id,tags,core,store.personRevision(id));};
 meta('tw1',['vip','friend'],null);meta('tw7',['mod'],true);meta('tw2',[],false);meta('UCyt1',['tube'],true);
 const bot=person('tw23');if(bot)store.setPersonBot(bot,true,store.personRevision(bot));
 const source=person('tw8'),target=person('tw9');if(source&&target)store.merge(source,target,store.personRevision(source),store.personRevision(target),SYNTHETIC_END);
 if(sessions[6]&&sessions[7])store.mergeSessions([sessions[6],sessions[7]]);
 return {sessions,excludedLogins:['jeetbot','nightbot'],ownerId:'owner',youtubeAccount:'yt-owner'};
}
