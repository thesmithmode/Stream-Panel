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
  for(const sample of samples){const active=activePlatforms?.filter(p=>p.from<sample.observed_at_ms+60000&&p.to>sample.observed_at_ms).map(p=>p.platform)??['twitch','youtube'];
   const value=key==='all'?(active.some(platform=>sample[platform==='twitch'?'twitch_viewers':'youtube_viewers']===null)?null:active.reduce((sum,platform)=>sum+(sample[platform==='twitch'?'twitch_viewers':'youtube_viewers']??0),0)):sample[key];if(value===null)continue;const at=Math.floor(sample.observed_at_ms/60000)*60000;if(durationInMinute(at,segments))minutes.set(at,value);}
  let knownMs=0,total=0,peak:number|null=null;
  for(const [at,value] of minutes){const elapsed=durationInMinute(at,segments);knownMs+=elapsed;total+=value*elapsed;peak=peak===null?value:Math.max(peak,value);}
  return {peak,mean:knownMs?total/knownMs:null,knownMinutes:knownMs/60000,coverageRatio:durationMs?knownMs/durationMs:null,viewerMinutes:knownMs?total/60000:null};
 };
 return {uniqueChatters:chatters.size,peakChatters,meanChatters:durationMs?chatterMinutes*60000/durationMs:null,viewers:{all:viewers('all'),twitch:viewers('twitch_viewers'),youtube:viewers('youtube_viewers')}};
}
