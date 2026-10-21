<script lang="ts">
 import {latestRequest} from './latest-request';
 import {api,date} from './api';
 import {ConnectionError} from './request';
 import Help from './Help.svelte';
 let {personId='',sessionId='',embedded=false,onPerson}:{personId?:string;sessionId?:string;embedded?:boolean;onPerson:(id:string)=>void}=$props();
 let data=$state<any>(null),error=$state('');
 const followingHelp='Follow Twitch и подписка YouTube. Статус относится к последней успешной проверке. Отписка Twitch обнаруживается полным опросом: её время — момент обнаружения, точное время недоступно. YouTube скрывает частные подписки; отсутствие в ответе не доказывает отписку. История изменений хранится с подключения панели. Время проверки и дата подписки — разные данные.';
 const platform=(source:string)=>source==='twitch'?'Twitch':'YouTube';
 const status=(value:boolean|null)=>value===true?'Подписан':value===false?'Не подписан':'Неизвестно';
 const time=(at:number)=>new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'}).format(at);

 $effect(()=>{
  const person=personId,session=sessionId,request=latestRequest();data=null;error='';
  const path=person?`persons/${person}/following?${new URLSearchParams({session})}`:`sessions/${session}/followers`;
  const load=()=>void request.run(signal=>api(path,undefined,signal),result=>{data=result;error='';},failure=>{if(!(failure instanceof ConnectionError))error=failure.message;});
  load();window.addEventListener('sp:data-refresh',load);
  return()=>{request.cancel();window.removeEventListener('sp:data-refresh',load);};
 });
</script>
<section class="panel following" class:embedded aria-label={personId?"Подписки на канал":"Подписчики за стрим"}>
{#if embedded}<div class="following-info"><Help trigger="О подписках" id="following-help" label="О подписках на канал" text={followingHelp} /></div>{:else} <header><h2>{personId?'Подписки на канал':'Подписчики за стрим'} <Help id="following-help" label="О подписках на канал" text={followingHelp} /></h2></header>{/if}
 {#if error}<p class="muted" role="status">{error}</p>{/if}
 {#if data===null}<p class="muted">Загружаем подписки…</p>
 {:else if personId}
  {#each data as row}<article class="follow-platform"><h4>{platform(row.source)} · {row.name}</h4>
   <p class="follow-state"><strong>{status(row.status)}</strong>{#if row.checkedAtMs!==null}<span class="small muted">Проверено {date(row.checkedAtMs)}</span>{/if}</p>
   {#if row.followedAtMs!==null}<p class="small">Последняя известная дата подписки: {date(row.followedAtMs)}</p>{/if}
   {#if sessionId}<p class="small">На момент стрима: {status(row.streamStatus)}</p>{/if}
   {#if row.history.length}<details><summary>История изменений ({row.history.length})</summary><ul>{#each [...row.history].sort((a,b)=>b.at-a.at) as item}<li>{date(item.at)} · {status(item.status)}{#if item.status&&item.followedAtMs!==null}<span class="small muted"> · подписался {date(item.followedAtMs)}</span>{/if}</li>{/each}</ul></details>{/if}
  </article>{:else}<p class="muted">Нет связанных аккаунтов Twitch или YouTube.</p>{/each}
 {:else}
  <div class="follow-summary">
   {#each data.newFollowers??[] as follower}<div class="follower-row"><span class={follower.source==='twitch'?'twitch':'youtube'}>{platform(follower.source)}</span>{#if follower.personId}<button class="text-button" onclick={()=>onPerson(follower.personId)}>{follower.name}</button>{:else}<span>{follower.name}</span>{/if}<time title={date(follower.at)}>{time(follower.at)}</time></div>{/each}
   {#each (data.platforms??[]).filter((row:any)=>row.change!==null&&row.change!==row.knownNew&&row.change!==0) as row}<p class="small muted" title={`Замеры ${time(row.fromAt)}–${time(row.toAt)} МСК: ${row.startTotal} → ${row.endTotal}`}>{platform(row.source)}: общее число {row.change>0?'+':''}{row.change}{row.knownNew?` · новых поимённо: ${row.knownNew}`:''}</p>{/each}
   {#if !(data.newFollowers??[]).length&&!(data.platforms??[]).some((row:any)=>row.change!==null&&row.change!==0)}<p class="muted">Новых подписок не зафиксировано.</p>{/if}
  </div>
 {/if}
</section>
<style>.embedded{border:0;border-radius:0;margin:0}.embedded .follow-summary{padding:0}.following-info{margin-bottom:8px}.follow-summary{padding:10px 20px}.follow-summary p{margin:6px 0}.follower-row{display:flex;gap:12px;align-items:baseline;padding:6px 0;font-size:13px;overflow-wrap:anywhere}.follower-row>span:first-child{font-size:11px;flex-shrink:0}.follower-row time{margin-left:auto;color:var(--muted);font-size:11px;white-space:nowrap}.twitch{color:var(--twitch,#a970ff)}.youtube{color:var(--youtube,#ff5959)}.following{margin-bottom:16px}.follow-platform{padding:14px 20px;border-bottom:1px solid var(--border)}.follow-platform:last-child{border-bottom:0}h4{margin:0 0 8px;font-size:14px}.follow-state{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;align-items:baseline}.follow-platform p{margin-bottom:8px}ul{padding-left:18px;max-height:240px;overflow:auto;font-size:12px;line-height:1.8}summary{cursor:pointer}li{overflow-wrap:anywhere}@media(max-width:600px){.follow-platform,.follow-summary{padding:10px 16px}}</style>
