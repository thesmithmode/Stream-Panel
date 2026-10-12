<script lang="ts">
 import {api,date} from './api';
 import {ConnectionError} from './request';
 import Help from './Help.svelte';
 let {personId='',sessionId='',onPerson}:{personId?:string;sessionId?:string;onPerson:(id:string)=>void}=$props();
 let data=$state<any>(null),error=$state('');
 const platform=(source:string)=>source==='twitch'?'Twitch':'YouTube';
 const status=(value:boolean|null)=>value===true?'Подписан':value===false?'Не подписан':'Неизвестно';
 const changes=$derived.by(()=>{const prior=new Map<string,string>();return (data?.polls??[]).filter((p:any)=>{const key=p.source,value=JSON.stringify([p.source==='youtube'?null:p.total,p.visibleCount]);if(prior.get(key)===value)return false;prior.set(key,value);return true;});});
 $effect(()=>{
  const person=personId,session=sessionId;let cancelled=false,pending=false;data=null;error='';
  const path=person?`persons/${person}/following?${new URLSearchParams({session})}`:`sessions/${session}/followers`;
  const load=()=>{if(pending||document.hidden||!navigator.onLine)return;pending=true;void api(path).then(result=>{if(!cancelled){data=result;error='';}}).catch(e=>{if(!cancelled&&!(e instanceof ConnectionError))error=e.message;}).finally(()=>pending=false);};
  load();const timer=setInterval(load,60000);window.addEventListener('online',load);document.addEventListener('visibilitychange',load);
  return()=>{cancelled=true;clearInterval(timer);window.removeEventListener('online',load);document.removeEventListener('visibilitychange',load);};
 });
</script>
<section class="panel following" aria-label="Подписки на канал">
 <header><h2>Подписки на канал <Help id="following-help" label="О подписках на канал" text="Follow Twitch и подписка YouTube. Статус относится к последней успешной проверке. Отписка Twitch обнаруживается полным опросом: её время — момент обнаружения, точное время недоступно. YouTube скрывает частные подписки; отсутствие в ответе не доказывает отписку. История изменений хранится с подключения панели. Время проверки и дата подписки — разные данные." /></h2></header>
 {#if error}<p class="muted" role="status">{error}</p>{/if}
 {#if data===null}<p class="muted">Загружаем подписки…</p>
 {:else if personId}
  {#each data as row}<article class="follow-platform"><h4>{platform(row.source)} · {row.name}</h4>
   <p class="follow-state"><strong>{status(row.status)}</strong>{#if row.checkedAtMs!==null}<span class="small muted">Проверено {date(row.checkedAtMs)}</span>{/if}</p>
   {#if row.followedAtMs!==null}<p class="small">Последняя известная дата подписки: {date(row.followedAtMs)}</p>{/if}
   {#if sessionId}<p class="small">На момент стрима: {status(row.streamStatus)}</p>{/if}
   {#if row.history.length}<details><summary>История изменений ({row.history.length})</summary><ul>{#each row.history as item}<li>{date(item.at)} · {status(item.status)}{#if item.status&&item.followedAtMs!==null}<span class="small muted"> · подписался {date(item.followedAtMs)}</span>{/if}</li>{/each}</ul></details>{/if}
  </article>{:else}<p class="muted">Нет связанных аккаунтов Twitch или YouTube.</p>{/each}
 {:else}
  <p>Новых подписок за стрим: <strong>{data.newFollowers.length}</strong></p>
  {#if data.newFollowers.length}<ul>{#each data.newFollowers as follower}<li>{platform(follower.source)} · {#if follower.personId}<button class="text-button" onclick={()=>onPerson(follower.personId)}>{follower.name}</button>{:else}{follower.name}{/if} · подписался {date(follower.at)}</li>{/each}</ul>{/if}
  {#if changes.length}<details><summary>Изменения числа подписчиков</summary><ul>{#each changes as poll}<li>{platform(poll.source)} · проверено {date(poll.at)} · {poll.source!=='youtube'&&poll.total!==null?`${poll.total} подписчиков`:`${poll.visibleCount} публичных аккаунтов`}{poll.complete?'':' · частично'}</li>{/each}</ul></details>{/if}
 {/if}
</section>
<style>.following{margin-bottom:16px}.follow-platform{padding:14px 20px;border-bottom:1px solid var(--border)}.follow-platform:last-child{border-bottom:0}h4{margin:0 0 8px;font-size:14px}.follow-state{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;align-items:baseline}.follow-platform p{margin-bottom:8px}ul{padding-left:18px;max-height:240px;overflow:auto;font-size:12px;line-height:1.8}summary{cursor:pointer}li{overflow-wrap:anywhere}@media(max-width:600px){.follow-platform{padding:12px 16px}}</style>
