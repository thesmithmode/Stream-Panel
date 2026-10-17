<script lang="ts">
 import {latestRequest} from './latest-request';
 import {api,date} from './api';
 import {ConnectionError} from './request';
 import Help from './Help.svelte';
 let {personId='',sessionId='',onPerson}:{personId?:string;sessionId?:string;onPerson:(id:string)=>void}=$props();
 let data=$state<any>(null),error=$state('');
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
<section class="panel following" aria-label={personId?"Подписки на канал":"Подписчики за стрим"}>
 <header><h2>{personId?'Подписки на канал':'Подписчики за стрим'} <Help id="following-help" label="О подписках на канал" text="Follow Twitch и подписка YouTube. Статус относится к последней успешной проверке. Отписка Twitch обнаруживается полным опросом: её время — момент обнаружения, точное время недоступно. YouTube скрывает частные подписки; отсутствие в ответе не доказывает отписку. История изменений хранится с подключения панели. Время проверки и дата подписки — разные данные." /></h2></header>
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
  <div class="follow-summary">
  {#each data.platforms??[] as row}<article class="follow-result">
   <h4 class={row.source==='twitch'?'twitch':'youtube'}>{platform(row.source)}</h4>
   <div class="follow-numbers"><div><span>{row.source==='youtube'?'Известных публичных подписок':'Известных новых подписок'}</span><strong>{row.knownNew}</strong></div>
    <div><span>Изменение общего числа</span><strong>{row.change===null?'—':`${row.change>0?'+':''}${row.change}`}</strong></div></div>
   {#if row.change!==null}<p class="small muted">{row.startTotal} → {row.endTotal} · замеры {time(row.fromAt)}–{time(row.toAt)} МСК</p>
   {:else}<p class="small muted">{row.source==='youtube'?'Частные подписки скрыты; точный прирост за эфир недоступен.':'Недостаточно замеров для расчёта изменения.'}</p>{/if}
   {#if row.knownNew}<details><summary>Кто подписался · {row.knownNew}</summary><ul class="follower-list">{#each data.newFollowers.filter((f:any)=>f.source===row.source&&f.account===row.account) as follower}<li><span>{#if follower.personId}<button class="text-button" onclick={()=>onPerson(follower.personId)}>{follower.name}</button>{:else}{follower.name}{/if}</span><time title={date(follower.at)}>{time(follower.at)} МСК</time></li>{/each}</ul></details>{/if}
  </article>{:else}<p class="muted">Подтверждённых данных о подписчиках за этот эфир нет.</p>{/each}
  <p class="small muted follow-note">Изменение общего числа учитывает подписки и отписки между замерами. Имена доступны только для известных новых подписок.</p>
  </div>
 {/if}
</section>
<style>.follow-summary{padding:0 20px 16px}.follow-result{padding:16px 0;border-bottom:1px solid var(--border)}.follow-result:last-of-type{border-bottom:0}.follow-numbers{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:12px 0}.follow-numbers span{display:block;font-size:12px;color:var(--muted);line-height:1.5}.follow-numbers strong{font-size:24px;display:block;margin-top:5px}.follow-note{margin-top:12px}.follower-list{list-style:none;padding:0}.follower-list li{display:flex;align-items:baseline;gap:12px;justify-content:space-between;padding:5px 0}.follower-list time{white-space:nowrap;color:var(--muted);font-size:11px}.twitch{color:var(--twitch,#a970ff)}.youtube{color:var(--youtube,#ff5959)}@media(max-width:600px){.follow-summary{padding:0 16px 12px}}.following{margin-bottom:16px}.follow-platform{padding:14px 20px;border-bottom:1px solid var(--border)}.follow-platform:last-child{border-bottom:0}h4{margin:0 0 8px;font-size:14px}.follow-state{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;align-items:baseline}.follow-platform p{margin-bottom:8px}ul{padding-left:18px;max-height:240px;overflow:auto;font-size:12px;line-height:1.8}summary{cursor:pointer}li{overflow-wrap:anywhere}@media(max-width:600px){.follow-platform{padding:12px 16px}}</style>
