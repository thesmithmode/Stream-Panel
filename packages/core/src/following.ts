import type Database from 'better-sqlite3';
export interface Follower {id:string;name:string;followedAtMs:number|null;raw?:unknown}
interface Poll {at:number;payload_json:string}
interface Snapshot {followers:Follower[];complete:boolean;total:number|null}
export interface FollowState {source:string;account:string;externalId:string;name:string;status:boolean|null;checkedAtMs:number|null;followedAtMs:number|null;streamStatus:boolean|null;streamCheckedAtMs:number|null;followedDuringStreamMs:number|null;firstMessageMs:number|null;firstSeenInChatMs:number|null;history:{at:number;status:boolean|null;followedAtMs:number|null}[]}
const state=(poll:Poll|undefined,id:string,source:string)=>{
 const data:Snapshot|undefined=poll?JSON.parse(poll.payload_json):undefined,member=data?.followers.find(f=>f.id===id);
 return {status:member?true:data?.complete&&source==='twitch'?false:null,checkedAtMs:poll?.at??null,followedAtMs:member?.followedAtMs??null};
};
export function personFollowing(db:Database.Database,person:string,session:string=''):FollowState[]{
 const identities=db.prepare(`SELECT source,account_id AS account,external_id AS externalId,display_name AS name FROM identities WHERE person_id=? AND source='twitch'
 UNION ALL SELECT 'youtube',account_id,external_id,display_name FROM youtube_identities WHERE person_id=?`).all(person,person) as {source:string;account:string;externalId:string;name:string}[];
 const stream=session?db.prepare('SELECT started_at_ms AS start,ended_at_ms AS end FROM sessions WHERE id=?').get(session) as {start:number;end:number|null}:undefined;
 return identities.map(i=>{
  const polls=db.prepare("SELECT observed_at_ms AS at,payload_json FROM provider_snapshots WHERE source=? AND account_id=? AND key='followers' ORDER BY observed_at_ms DESC,id DESC LIMIT 50").all(i.source,i.account) as Poll[];
  let latest=state(polls[0],i.externalId,i.source);
  const follow=db.prepare(`SELECT e.occurred_at_ms AS at,e.received_at_ms AS received FROM effective_events e JOIN identities i ON i.id=e.identity_id WHERE i.person_id=? AND e.source=? AND e.account_id=? AND e.type='follow' ORDER BY e.occurred_at_ms DESC LIMIT 1`).get(person,i.source,i.account) as {at:number;received:number}|undefined;
  if(follow&&follow.received>(latest.checkedAtMs??-1))latest={status:true,checkedAtMs:follow.received,followedAtMs:follow.at};
  const knownDate=db.prepare("SELECT json_extract(f.value,'$.followedAtMs') AS at FROM provider_snapshots p,json_each(p.payload_json,'$.followers') f WHERE p.source=? AND p.account_id=? AND p.key='followers' AND json_extract(f.value,'$.id')=? AND json_type(f.value,'$.followedAtMs')='integer' ORDER BY p.observed_at_ms DESC,p.id DESC LIMIT 1").get(i.source,i.account,i.externalId) as {at:number}|undefined;
  const lastDate=Math.max(latest.followedAtMs??-1,follow?.at??-1,knownDate?.at??-1);latest.followedAtMs=lastDate<0?null:lastDate;
  const historical=stream?db.prepare("SELECT observed_at_ms AS at,payload_json FROM provider_snapshots WHERE source=? AND account_id=? AND key='followers' AND observed_at_ms BETWEEN ? AND ? ORDER BY observed_at_ms DESC,id DESC LIMIT 200").all(i.source,i.account,stream.start,stream.end??Date.now()) as Poll[]:[];
  const during=historical[0];
  let historic=state(during,i.externalId,i.source);
  const dates=[follow?.at,...[...polls,...historical].map(p=>state(p,i.externalId,i.source).followedAtMs)].filter((at):at is number=>at!=null);
  const streamDate=stream?db.prepare("SELECT min(json_extract(f.value,'$.followedAtMs')) AS at FROM provider_snapshots p,json_each(p.payload_json,'$.followers') f WHERE p.source=? AND p.account_id=? AND p.key='followers' AND json_extract(f.value,'$.id')=? AND json_extract(f.value,'$.followedAtMs') BETWEEN ? AND ?").get(i.source,i.account,i.externalId,stream.start,stream.end??Date.now()) as {at:number|null}:undefined;
  const followedDuringStreamMs=stream?dates.find(at=>at>=stream.start&&at<=(stream.end??Date.now()))??streamDate?.at??null:null;
  if(followedDuringStreamMs!==null&&followedDuringStreamMs>(historic.checkedAtMs??-1))historic={status:true,checkedAtMs:followedDuringStreamMs,followedAtMs:followedDuringStreamMs};
  const message=i.source==='youtube'?db.prepare('SELECT min(published_at_ms) AS at FROM youtube_messages WHERE account_id=? AND author_id=?').get(i.account,i.externalId):db.prepare("SELECT min(e.occurred_at_ms) AS at FROM effective_events e JOIN identities i ON i.id=e.identity_id WHERE i.person_id=? AND e.source='twitch' AND e.account_id=? AND e.type='chat.message'").get(person,i.account);
  const seen=i.source==='twitch'?db.prepare("SELECT min(p.completed_at_ms) AS at FROM presence_polls p JOIN presence_members m ON m.poll_id=p.id JOIN identities i ON i.id=m.identity_id WHERE i.person_id=? AND i.account_id=? AND p.status='complete'").get(person,i.account):message;
  const history=polls.slice().reverse().map(p=>({at:p.at,...state(p,i.externalId,i.source)})).filter((p,n,a)=>!n||p.status!==a[n-1]!.status||p.followedAtMs!==a[n-1]!.followedAtMs).slice(-50).map(p=>({at:p.at,status:p.status,followedAtMs:p.followedAtMs}));
  return {...i,...latest,streamStatus:historic.status,streamCheckedAtMs:historic.checkedAtMs,followedDuringStreamMs,firstMessageMs:(message as {at:number|null}).at,firstSeenInChatMs:(seen as {at:number|null}).at,history};
 });
}
export function followingAnalytics(db:Database.Database,id:string){
 const stream=db.prepare('SELECT started_at_ms AS start,ended_at_ms AS end FROM sessions WHERE id=?').get(id) as {start:number;end:number|null};const end=stream.end??Date.now();
 const polls=db.prepare("SELECT source,account_id AS account,observed_at_ms AS at,payload_json FROM provider_snapshots p WHERE key='followers' AND ((observed_at_ms>=? AND observed_at_ms<=?) OR id=(SELECT q.id FROM provider_snapshots q WHERE q.source=p.source AND q.account_id=p.account_id AND q.key='followers' ORDER BY q.observed_at_ms DESC,q.id DESC LIMIT 1)) ORDER BY observed_at_ms").all(stream.start,end) as (Poll&{source:string;account:string})[];
 const signups=new Map<string,{source:string;account:string;externalId:string;name:string;at:number;personId:string|null}>();
 const add=(source:string,account:string,f:Follower)=>{
  if(f.followedAtMs===null||f.followedAtMs<stream.start||f.followedAtMs>end)return;
  const person=source==='youtube'?db.prepare('SELECT person_id AS id FROM youtube_identities WHERE account_id=? AND external_id=?').get(account,f.id):db.prepare('SELECT person_id AS id FROM identities WHERE source=? AND account_id=? AND external_id=?').get(source,account,f.id);
  signups.set(`${source}:${account}:${f.id}:${f.followedAtMs}`,{source,account,externalId:f.id,name:f.name,at:f.followedAtMs,personId:(person as {id:string}|undefined)?.id??null});
 };
 for(const p of polls)for(const f of (JSON.parse(p.payload_json) as Snapshot).followers)add(p.source,p.account,f);
 const events=db.prepare("SELECT e.source,e.account_id AS account,i.external_id AS id,i.display_name AS name,e.occurred_at_ms AS at FROM effective_events e JOIN identities i ON i.id=e.identity_id WHERE e.type='follow' AND e.occurred_at_ms BETWEEN ? AND ?").all(stream.start,end) as {source:string;account:string;id:string;name:string;at:number}[];
 for(const e of events)add(e.source,e.account,{id:e.id,name:e.name,followedAtMs:e.at});
 return {newFollowers:[...signups.values()].sort((a,b)=>a.at-b.at),polls:polls.filter(p=>p.at>=stream.start&&p.at<=end).map(p=>{const data=JSON.parse(p.payload_json) as Snapshot;return {at:p.at,source:p.source,total:data.total??data.followers.length,complete:data.complete};})};
}
