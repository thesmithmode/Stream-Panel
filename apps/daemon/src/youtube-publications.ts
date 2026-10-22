import type {Publication} from '../../../packages/core/src/subscriber-history.js';
interface Dependencies {
 account:string;at:number;valid:()=>boolean;channel:Record<string,any>;
 snapshots:Record<string,{data:any;updatedAt:number}>;
 api:(resource:string,params:Record<string,string>)=>Promise<Record<string,any>>;
 types:(params:Record<string,string>)=>Promise<Record<string,any>>;
 save:(items:Publication[],at:number)=>Promise<void>;
 cursor:(key:string,data:unknown)=>Promise<void>;
}
/** Length-based display matches these channels' short clips and >15 minute videos.
 * Analytics remains authoritative when it has processed an upload. */
export function publicationKind(duration:unknown):Publication['kind']{
 if(typeof duration!=='string')return 'unknown';
 const match=/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(duration);
 if(!match||!match.slice(1).some(Boolean))return 'unknown';
 const seconds=Number(match[1]??0)*86400+Number(match[2]??0)*3600+Number(match[3]??0)*60+Number(match[4]??0);
 return seconds>900?'video':seconds>0&&seconds<=180?'shorts':'unknown';
}
/** Uses the uploads playlist instead of expensive search requests. */
export async function collectYouTubePublications(d:Dependencies){
 if(d.at-(d.snapshots['cursor:publications']?.updatedAt??-Infinity)<900000)return;
 const playlist=d.channel.contentDetails?.relatedPlaylists?.uploads;
 if(typeof playlist!=='string'||!playlist)return;
 const cutoff=d.at-30*86400000,items=new Map<string,Publication>(),seen=new Set<string>();let page='';
 for(let n=0;n<20;n++){
  const response=await d.api('playlistItems',{part:'contentDetails',playlistId:playlist,maxResults:'50',...(page?{pageToken:page}:{})});if(!d.valid())return;
  if(!Array.isArray(response.items))throw new Error('INVALID_UPLOADS');
  let older=false;
  for(const row of response.items){
   const id=row?.contentDetails?.videoId,at=Date.parse(row?.contentDetails?.videoPublishedAt??'');
   if(typeof id!=='string'||!Number.isSafeInteger(at))continue;
   if(at<cutoff){older=true;continue;}if(at>d.at)continue;
   items.set(id,{id,title:'',publishedAt:at,kind:'unknown'});
  }
  page=response.nextPageToken??'';
  if(!page||older)break;
  if(typeof page!=='string'||seen.has(page))throw new Error('UPLOADS_PAGINATION_LOOP');seen.add(page);
  if(n===19)throw new Error('UPLOADS_PAGINATION_LIMIT');
 }
 const ids=[...items.keys()],videos:Publication[]=[];
 for(let offset=0;offset<ids.length;offset+=50){
  const batch=ids.slice(offset,offset+50),response=await d.api('videos',{part:'snippet,contentDetails,liveStreamingDetails,status',id:batch.join(',')});if(!d.valid())return;
  if(!Array.isArray(response.items))throw new Error('INVALID_UPLOAD_VIDEOS');
  for(const row of response.items){
   // A public archive is the same broadcast, not an additional uploaded video.
   if(!items.has(row?.id)||!batch.includes(row.id)||row.liveStreamingDetails||row.status?.privacyStatus!=='public')continue;
   const publishedAt=Date.parse(row.snippet?.publishedAt??'');
   if(!Number.isSafeInteger(publishedAt)||publishedAt<cutoff||publishedAt>d.at||typeof row.snippet?.title!=='string')continue;
   videos.push({id:row.id,title:row.snippet.title,publishedAt,kind:publicationKind(row.contentDetails?.duration)});
  }
 }
 // Analytics classifies Shorts authoritatively, but may not have processed a new upload.
 // Save neutral publications first: an unavailable report must not lose their dates.
 if(videos.length){await d.save(videos,d.at);if(!d.valid())return;}
 if(videos.length&&d.at-(d.snapshots['cursor:publicationTypes']?.updatedAt??-Infinity)>=21600000){
  try{
   const report=await d.types({ids:`channel==${d.account}`,startDate:new Date(cutoff).toISOString().slice(0,10),endDate:new Date(d.at).toISOString().slice(0,10),dimensions:'video,creatorContentType',metrics:'views',maxResults:'200',sort:'-views'});if(!d.valid())return;
   const headers=Array.isArray(report.columnHeaders)?report.columnHeaders:[],idIndex=headers.findIndex((h:any)=>h.name==='video'),kindIndex=headers.findIndex((h:any)=>h.name==='creatorContentType');
   if(idIndex<0||kindIndex<0||!Array.isArray(report.rows))throw new Error('INVALID_CONTENT_TYPES');
   const types=new Map<string,Publication['kind']>();
   for(const row of report.rows){const type=row[kindIndex];if(type==='SHORTS'||type==='VIDEO_ON_DEMAND')types.set(row[idIndex],type==='SHORTS'?'shorts':'video');}
   await d.save(videos.map(video=>({...video,kind:types.get(video.id)??video.kind})),d.at);if(!d.valid())return;
   await d.cursor('cursor:publicationTypes',true);
  }catch{/* Keep known publication times; retry classification on a later collection. */}
 }
 if(d.valid())await d.cursor('cursor:publications',true);
}
