import type {FastifyInstance} from 'fastify';
import type {ConfigurationPort} from './config.js';
import type {StorePort} from './store-contract.js';
import type {TwitchConnection} from './twitch.js';
import {object,string} from './provider-values.js';

export function registerClipRoutes(app:FastifyInstance,db:StorePort<'streamClips'|'saveStreamClip'>,
  config:ConfigurationPort,twitch:Pick<TwitchConnection,'api'>){
  type Archives = Map<string,string>;
  const archives=new Map<string,{expires:number;task:Promise<Archives>}>();
  function getArchives(account:string){
    const prior=archives.get(account);
    if(prior&&prior.expires>Date.now())return prior.task;
    archives.clear();
    const query=new URLSearchParams({user_id:account,type:'archive',first:'100'});
    const task=twitch.api(`videos?${query}`,{signal:AbortSignal.timeout(5000)}).then(raw=>{
      const data=object(raw).data;
      const ids:Archives=new Map();
      if(Array.isArray(data))for(const item of data){
        const row=object(item);
        if(row.user_id===account&&row.type==='archive'&&/^\d+$/.test(string(row.id))&&
          /^\d+$/.test(string(row.stream_id)))ids.set(string(row.stream_id),string(row.id));
      }
      return ids;
    }).catch(()=>new Map<string,string>());
    archives.set(account,{expires:Date.now()+60_000,task});
    return task;
  }

  app.get<{Params:{id:string}}>('/api/v1/sessions/:id/clips',async request=>{
    const account=config.value.twitch?.userId??'';
    const {activeStreamId,clips}=await db.call('streamClips',request.params.id,account);
    const ids=account&&clips.some(clip=>clip.accountId===account&&clip.streamId!==activeStreamId)
      ? await getArchives(account):new Map<string,string>();
    return {activeStreamId,clips:clips.map(({accountId,streamId,...clip})=>{
      const vod=accountId===account?ids.get(streamId):undefined;
      const seconds=Math.max(0,clip.positionSeconds-60);
      const time=`${Math.floor(seconds/3600)}h${Math.floor(seconds%3600/60)}m${seconds%60}s`;
      return {...clip,seconds,url:vod?`https://www.twitch.tv/videos/${vod}?t=${time}`:null};
    })};
  });

  app.post<{Params:{id:string};Body:{id:string;streamId:string}}>('/api/v1/sessions/:id/clips',{
    schema:{body:{type:'object',required:['id','streamId'],additionalProperties:false,
      properties:{id:{type:'string',format:'uuid'},streamId:{type:'string',pattern:'^[0-9]{1,32}$'}}}},
  },async request=>{
    // Capture the request time before waiting for Helix.
    const at=Date.now();
    const account=config.value.twitch?.userId;
    if(!account)throw new Error('TWITCH_LOGIN_REQUIRED');
    const {activeStreamId,clips}=await db.call('streamClips',request.params.id,account);
    const existing=clips.find(clip=>clip.id===request.body.id);
    if(existing)return existing;
    if(!activeStreamId||activeStreamId!==request.body.streamId)throw new Error('TWITCH_STREAM_OFFLINE');
    const raw=object(await twitch.api(`streams?user_id=${encodeURIComponent(account)}`,
      {signal:AbortSignal.timeout(5000)}));
    const live=Array.isArray(raw.data)?raw.data.map(object).find(row=>
      row.id===activeStreamId&&row.user_id===account&&row.type==='live'):undefined;
    const start=Date.parse(string(live?.started_at));
    if(!Number.isFinite(start)||start>at||config.value.twitch?.userId!==account)
      throw new Error('TWITCH_STREAM_OFFLINE');
    return db.call('saveStreamClip',request.params.id,account,activeStreamId,request.body.id,at,Math.floor((at-start)/1000));
  });
}
