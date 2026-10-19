export interface MetricSegment {from:number;to:number}
export interface ViewerSample {observed_at_ms:number;twitch_viewers:number|null;youtube_viewers:number|null}
function durationInMinute(at:number,segments:MetricSegment[]):number {
 return segments.reduce((sum,span)=>sum+Math.max(0,Math.min(at+60000,span.to)-Math.max(at,span.from)),0);
}
/** Means use recorded minutes only; absent samples remain unknown and coverage is explicit. */
export function streamMetrics(segments:MetricSegment[],samples:ViewerSample[],authors:Map<number,Set<string>>,activePlatforms?:{platform:string;from:number;to:number}[]) {
 const durationMs=segments.reduce((sum,span)=>sum+span.to-span.from,0);
 const chatters=new Set<string>();let peakChatters=0,chatterMinutes=0;
 for(const [at,ids] of authors){const elapsed=durationInMinute(at,segments);if(!elapsed)continue;for(const id of ids)chatters.add(id);peakChatters=Math.max(peakChatters,ids.size);chatterMinutes+=ids.size*elapsed/60000;}
 const viewers=(key:'twitch_viewers'|'youtube_viewers'|'all')=>{
  const minutes=new Map<number,number>();
  for(const sample of samples){const active=[...new Set(activePlatforms?.filter(p=>p.from<sample.observed_at_ms+60000&&p.to>sample.observed_at_ms).map(p=>p.platform)??['twitch','youtube'])];
   const value=key==='all'?(!active.length||active.some(platform=>sample[platform==='twitch'?'twitch_viewers':'youtube_viewers']===null)?null:active.reduce((sum,platform)=>sum+(sample[platform==='twitch'?'twitch_viewers':'youtube_viewers']??0),0)):sample[key];if(value===null)continue;const at=Math.floor(sample.observed_at_ms/60000)*60000;if(durationInMinute(at,segments))minutes.set(at,value);}
  let knownMs=0,total=0,peak:number|null=null;
  for(const [at,value] of minutes){const elapsed=durationInMinute(at,segments);knownMs+=elapsed;total+=value*elapsed;peak=peak===null?value:Math.max(peak,value);}
  return {peak,mean:knownMs?total/knownMs:null,knownMinutes:knownMs/60000,coverageRatio:durationMs?knownMs/durationMs:null,viewerMinutes:knownMs?total/60000:null};
 };
 // Providers poll independently. Join only within the same recorded minute;
 // absent providers remain unknown, while their known peers are still visible.
 const merged=new Map<number,ViewerSample>();
 for(const sample of samples){const at=Math.floor(sample.observed_at_ms/60000)*60000,row=merged.get(at)??{observed_at_ms:at,twitch_viewers:null,youtube_viewers:null};if(sample.twitch_viewers!==null)row.twitch_viewers=sample.twitch_viewers;if(sample.youtube_viewers!==null)row.youtube_viewers=sample.youtube_viewers;merged.set(at,row);}
 let knownMs=0,total=0,peak:number|null=null,partialMinutes=0;
 for(const row of merged.values()){
  const at=row.observed_at_ms,elapsed=durationInMinute(at,segments);
  const active=[...new Set(activePlatforms?.filter(p=>p.from<at+60000&&p.to>at).map(p=>p.platform)??['twitch','youtube'])];
  const values=active.map(platform=>row[platform==='twitch'?'twitch_viewers':'youtube_viewers']),known=values.filter((v):v is number=>v!==null);
  if(!elapsed||!known.length)continue;const value=known.reduce((n,v)=>n+v,0);knownMs+=elapsed;total+=value*elapsed;peak=peak===null?value:Math.max(peak,value);if(known.length<values.length)partialMinutes+=elapsed/60000;
 }
 const known={peak,mean:knownMs?total/knownMs:null,knownMinutes:knownMs/60000,coverageRatio:durationMs?knownMs/durationMs:null,viewerMinutes:knownMs?total/60000:null,partialMinutes};
 return {uniqueChatters:chatters.size,peakChatters,meanChatters:durationMs?chatterMinutes*60000/durationMs:null,viewers:{known,all:viewers('all'),twitch:viewers('twitch_viewers'),youtube:viewers('youtube_viewers')}};
}
