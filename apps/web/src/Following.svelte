<script lang="ts">
 import {api,date} from './api';
 import Help from './Help.svelte';
 let {personId='',sessionId='',onPerson}:{personId?:string;sessionId?:string;onPerson:(id:string)=>void}=$props();
 let data=$state<any>(null),error=$state('');
 const platform=(source:string)=>source==='twitch'?'Twitch':'YouTube';
 const status=(value:boolean|null)=>value===true?'Подписан':value===false?'Не подписан':'Неизвестно';
 $effect(()=>{
  const person=personId,session=sessionId;let cancelled=false;data=null;error='';
  const path=person?`persons/${person}/following?${new URLSearchParams({session})}`:`sessions/${session}/followers`;
  const load=()=>{if(document.hidden||!navigator.onLine)return;void api(path).then(result=>{if(!cancelled){data=result;error='';}}).catch(e=>{if(!cancelled)error=e.message;});};
  load();const timer=setInterval(load,60000);window.addEventListener('online',load);window.addEventListener('focus',load);document.addEventListener('visibilitychange',load);
  return()=>{cancelled=true;clearInterval(timer);window.removeEventListener('online',load);window.removeEventListener('focus',load);document.removeEventListener('visibilitychange',load);};
 });
</script>
<section class="panel following" aria-label="Подписки на канал">
 <header><h2>Подписки на канал <Help id="following-help" label="О подписках на канал" text="Здесь подписка означает follow Twitch или подписку YouTube на канал. Это не платная подписка Twitch. Дата проверки указана рядом со статусом. YouTube скрывает часть подписчиков: отсутствие в списке означает «неизвестно». Первый вход — первое сохранённое присутствие в чате, а не начало просмотра видео. История собирается с подключения; прошлое восстановить полностью нельзя." /></h2></header>
 {#if error}<p class="muted" role="status">{error}</p>{/if}{#if data===null}{#if !error}<p class="muted">Загрузка подписок…</p>{/if}
 {:else if personId}
  {#each data as row}<article class="follow-platform"><h4>{platform(row.source)} · {row.name}</h4>
   <dl><div><dt>Последний статус</dt><dd>{status(row.status)}{#if row.checkedAtMs!==null} · {date(row.checkedAtMs)}{/if}</dd></div>
    {#if sessionId}<div><dt>На момент стрима</dt><dd>{status(row.streamStatus)}{#if row.streamCheckedAtMs!==null} · {date(row.streamCheckedAtMs)}{/if}</dd></div>{/if}
    <div><dt>Последняя известная дата подписки</dt><dd>{row.followedAtMs===null?'Дата неизвестна':date(row.followedAtMs)}</dd></div>
    {#if row.followedDuringStreamMs!==null}<div><dt>Подписался во время стрима</dt><dd>{date(row.followedDuringStreamMs)}</dd></div>{/if}
    <div><dt>Первое сообщение</dt><dd>{row.firstMessageMs===null?'Сообщений не было':date(row.firstMessageMs)}</dd></div>
    <div><dt>Впервые замечен в чате</dt><dd>{row.firstSeenInChatMs===null?'Не зафиксировано':date(row.firstSeenInChatMs)}</dd></div>
   </dl>
   {#if row.history.length}<details><summary>История проверок</summary><ul>{#each row.history as item}<li>{date(item.at)} · {status(item.status)}{#if item.followedAtMs!==null} · подписался {date(item.followedAtMs)}{/if}</li>{/each}</ul></details>{/if}
  </article>{:else}<p class="muted">Нет связанных аккаунтов Twitch или YouTube.</p>{/each}
 {:else}
  {#if data.polls.length||data.newFollowers.length}<p>Новых подписок за стрим: <strong>{data.newFollowers.length}</strong></p>{:else}<p class="muted">Данных о подписках за этот стрим пока нет.</p>{/if}
  {#if data.polls.length}<details><summary>История числа подписчиков</summary><ul>{#each data.polls as poll}<li>{platform(poll.source)} · {date(poll.at)} · {poll.total}{poll.complete?'':' · частично'}</li>{/each}</ul></details>{/if}
  {#if data.newFollowers.length}<ul>{#each data.newFollowers as follower}<li>{platform(follower.source)} · {#if follower.personId}<button class="text-button" onclick={()=>onPerson(follower.personId)}>{follower.name}</button>{:else}{follower.name}{/if} · {date(follower.at)}</li>{/each}</ul>{/if}
 {/if}
</section>
<style>.following{margin-bottom:16px}.follow-platform{padding:8px 0}h4{margin:4px 0}dl{margin:8px 0}dl>div{display:grid;grid-template-columns:minmax(120px,1fr) 2fr;gap:10px;margin:8px 0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}ul{padding-left:20px;max-height:200px;overflow:auto}summary{cursor:pointer}@media(max-width:600px){dl>div{grid-template-columns:1fr}}</style>
