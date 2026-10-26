<script lang="ts">
 import {onMount,untrack} from 'svelte';
 import {money} from './api';
 import {cachedOverview,loadOverview,type OverviewTotals} from './analytics-cache';
 import {num} from './format';
 import {ConnectionError} from './request';
 import {formatDuration,formatHours} from './duration';
 let {connect,profile,timezone='Europe/Moscow'}:{connect:()=>void;profile:string;timezone?:string}=$props();
 let data=$state<OverviewTotals|null>(untrack(()=>cachedOverview(profile)??null)),error=$state('');
 const recordDate=(at:number)=>new Date(at).toLocaleDateString('ru-RU',{timeZone:timezone});
 onMount(()=>{
  let alive=true,pending=false;
  const refresh=async(force=false)=>{if(pending)return;pending=true;try{const value=await loadOverview(profile,force);if(alive){data=value;error='';}}catch(e){if(alive&&!(e instanceof ConnectionError))error=(e as Error).message;}finally{pending=false;}};
  const update=()=>void refresh(true);
  void refresh();window.addEventListener('sp:data-refresh',update);
  return()=>{alive=false;window.removeEventListener('sp:data-refresh',update);};
 });
</script>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if data}
 <section class="metrics channel-metrics" aria-label="Статистика канала за всю историю">
  <div class="metric"><div><span>Стримы</span><strong>{data.streams}</strong></div></div>
  <div class="metric"><div><span>Время эфиров</span><strong>{#each formatDuration(data.durationMinutes).split(/ (?=\d)/) as part,i}{i?' ':''}<span class="duration-part">{part}</span>{/each}</strong><small>({formatHours(data.durationMinutes)})</small></div></div>
  <div class="metric"><div><span>Участники чата</span><strong>{data.attendees}</strong></div></div>
  <div class="metric"><div><span>Сообщения</span><strong>{data.messages.toLocaleString('ru-RU')}</strong></div></div>
  <div class="metric"><div><span>Донаты</span><strong>{data.donations}</strong></div></div>
  <div class="metric"><div><span>Сумма донатов</span>{#each Object.entries(data.totals) as [currency,amount]}<strong>{money(amount,currency)}</strong>{:else}<strong>—</strong>{/each}</div></div>
 </section>
 <h2 class="records-heading">Рекорды за эфир</h2>
 <section class="metrics channel-records" aria-label="Рекорды канала">
  {#each [['online','Средний онлайн'],['messages','Сообщения'],['peakOnline','Пик зрителей'],['peakChat','Пик участников чата']] as [key,label]}{@const record=data.records?.[key as 'online'|'messages'|'peakOnline'|'peakChat']}
   <div class="metric"><div><span>{label}</span><strong>{record?num(record.value):'—'}</strong><small>{record?recordDate(record.at):'Нет данных'}</small></div></div>
  {/each}
 </section>
 {#if !data.streams}<section class="panel"><div class="empty-small"><p>Стримы появятся автоматически после подключения площадок.</p><button class="primary" onclick={connect}>Открыть интеграции</button></div></section>{/if}
{:else}<p class="muted" role="status">Загружаем итоги…</p>{/if}

<style>.duration-part{font-size:inherit;color:inherit;line-height:inherit;white-space:nowrap}.records-heading{font-size:17px;margin:24px 0 12px}.channel-records{grid-template-columns:repeat(2,minmax(0,1fr));margin-top:0}.channel-records small{color:var(--muted)}</style>
