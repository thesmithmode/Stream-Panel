<script lang="ts">
 import {latestRequest} from './latest-request';
 import {api,date} from './api';
 import {ConnectionError} from './request';
 import Help from './Help.svelte';
 let {preloaded,sessionId='',fromMs=0,toMs=0,embedded=false,hideEmpty=false,onPerson}:{preloaded?:Promise<any>|undefined;sessionId?:string;fromMs?:number;toMs?:number;embedded?:boolean;hideEmpty?:boolean;onPerson:(id:string)=>void}=$props();
 let data=$state<any>(null),error=$state(''),limit=$state(10);
 const changes=$derived([...((data?.newFollowers??[]).map((row:any)=>({...row,following:true}))),...((data?.unfollowers??[]).map((row:any)=>({...row,following:false})))].sort((a,b)=>b.at-a.at));
 const hasFollowers=$derived(changes.length>0||(data?.platforms??[]).some((row:any)=>row.change!==null&&row.change!==0));
 const followingHelp='Follow Twitch и публичные подписки YouTube. Отписка Twitch обнаруживается полным опросом: указано время обнаружения. YouTube скрывает частные подписки, поэтому отсутствие в ответе не считается отпиской. История хранится с подключения панели.';
 const platform=(source:string)=>source==='twitch'?'Twitch':'YouTube';
 async function openFollower(follower:any){
  try{const personId=follower.personId??(await api('followers/person',{source:follower.source,account:follower.account,externalId:follower.externalId})).personId;onPerson(personId);}
  catch(failure){error=failure instanceof Error?failure.message:String(failure);}
 }
 const eventDate=(at:number)=>new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric'}).format(at);
 const time=(at:number)=>new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'}).format(at);
 $effect(()=>{
  const session=sessionId,from=fromMs,to=toMs,request=latestRequest();data=null;error='';limit=10;
  const prepared=preloaded;let initial=true;
  const load=()=>{const task=initial?prepared:undefined;initial=false;void request.run(signal=>task??api(session?`sessions/${session}/followers`:`followers/changes?${new URLSearchParams({from:String(from),to:String(to)})}`,undefined,signal),result=>{data=result;error='';},failure=>{if(!(failure instanceof ConnectionError))error=failure.message;});};
  load();if(!prepared)window.addEventListener('sp:data-refresh',load);return()=>{request.cancel();window.removeEventListener('sp:data-refresh',load);};
 });
</script>
{#if !hideEmpty||hasFollowers||error}
<section class="panel following" class:embedded aria-label={sessionId?"Подписчики за стрим":"Подписки и отписки за период"}>
 {#if embedded}<div class="following-info"><Help trigger="О подписках" id="following-help" label="О подписках на канал" text={followingHelp}/></div>{:else}<header><h2>Подписки и отписки <Help id="following-help" label="О подписках на канал" text={followingHelp}/></h2></header>{/if}
 {#if error}<p class="muted" role="status">{error}</p>{/if}
 {#if data===null}<p class="muted">Загружаем подписки…</p>{:else}<div class="follow-summary">
  <p class="small muted history-caption">Сначала новые · время МСК · показано {Math.min(limit,changes.length)} из {changes.length}</p>
  {#each changes.slice(0,limit) as follower}<div class="follower-row" class:unfollowed={!follower.following}><span class={follower.source==='twitch'?'twitch':'youtube'}>{platform(follower.source)}</span><button class="text-button follower-name" onclick={()=>openFollower(follower)}>{follower.name}</button><span class="follow-change">{follower.following?'Подписался':'Отписался'}</span><time datetime={new Date(follower.at).toISOString()} title={date(follower.at)}>{eventDate(follower.at)} · {time(follower.at)}</time></div>{/each}
  <div class="history-actions">{#if changes.length>limit}<button class="text-button" onclick={()=>limit+=10}>Показать ещё {Math.min(10,changes.length-limit)}</button>{/if}{#if limit>10}<button class="text-button" onclick={()=>limit=10}>Свернуть</button>{/if}</div>
  {#each (data.platforms??[]).filter((row:any)=>row.change!==null&&row.change!==row.knownNew&&row.change!==0) as row}<p class="small muted" title={`Замеры ${time(row.fromAt)}–${time(row.toAt)} МСК: ${row.startTotal} → ${row.endTotal}`}>{platform(row.source)}: общее число {row.change>0?'+':''}{row.change}{row.knownNew?` · новых поимённо: ${row.knownNew}`:''}</p>{/each}
  {#if !hasFollowers}<p class="muted">Изменений подписок не зафиксировано.</p>{/if}
 </div>{/if}
</section>
{/if}
<style>
 .history-actions{display:flex;gap:16px;margin-top:8px}.history-caption{margin-bottom:10px}.embedded{border:0;border-radius:0;margin:0}.embedded .follow-summary{padding:0}.following-info{margin-bottom:8px}.follow-summary{padding:10px 20px}.follow-summary p{margin:6px 0}.follower-row{display:flex;gap:8px;align-items:baseline;padding:6px 0;font-size:13px;overflow-wrap:anywhere;flex-wrap:wrap}.follower-row>span:first-child{font-size:11px;flex-shrink:0}.follower-name{color:#78dba9}.unfollowed .follower-name{color:#ed8990}.follow-change{color:var(--muted);font-size:11px}.follower-row time{margin-left:auto;color:var(--muted);font-size:11px;white-space:nowrap}.twitch{color:var(--twitch,#a970ff)}.youtube{color:var(--youtube,#ff5959)}.following{margin-bottom:16px}@media(max-width:600px){.follow-summary{padding:10px 16px}}
</style>
