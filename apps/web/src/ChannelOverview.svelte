<script lang="ts">
 import {onMount} from 'svelte';
 import {money} from './api';
 import {loadAnalyticsView} from './analytics-view';
 import {loadAnalytics,loadOverview,summaryQuery,type OverviewTotals} from './analytics-cache';
 import {streamRecords} from './daily-metrics';
 import {num} from './format';
 import {ConnectionError} from './request';
 import {formatDuration,formatHours} from './duration';
 let {connect,profile,timezone='Europe/Moscow'}:{connect:()=>void;profile:string;timezone?:string}=$props();
 let data=$state<OverviewTotals|null>(null),error=$state(''),recordError=$state(false),records=$state<ReturnType<typeof streamRecords>|null>(null);
 const recordDate=(at:number)=>new Date(at).toLocaleDateString('ru-RU',{timeZone:timezone});
 onMount(()=>{
  let alive=true,pending=false,recordRevision=0;
  const refreshRecords=async(force=false)=>{const current=++recordRevision;try{const view=loadAnalyticsView(()=>localStorage,profile);const report=await loadAnalytics(profile,summaryQuery(0,Math.floor(Date.now()/60000)*60000,'all','',timezone,view.resolution,view.sort),force);if(alive&&current===recordRevision){records=streamRecords(report.streamComparison??[]);recordError=false;}}catch{if(alive&&current===recordRevision)recordError=true;}};
  const refresh=async(force=false)=>{if(pending)return;pending=true;try{const value=await loadOverview(profile,force);if(alive){data=value;error='';if(value.streams)void refreshRecords(force);else{recordRevision++;records=streamRecords([]);recordError=false;}}}catch(e){if(alive&&!(e instanceof ConnectionError))error=(e as Error).message;}finally{pending=false;}};
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
 <section class="metrics channel-records" aria-label="Рекорды канала" aria-busy={!!data.streams&&!records&&!recordError}>
  {#each [['online','Средний онлайн'],['messages','Сообщения']] as [key,label]}{@const record=records?.[key as 'online'|'messages']}
   <div class="metric"><div><span>{label}</span><strong>{record?num(record.value):'—'}</strong><small>{record?recordDate(record.at):recordError?'Не удалось загрузить':!records&&data.streams?'Загружаем…':'Нет данных'}</small></div></div>
  {/each}
 </section>
 {#if recordError}<button class="text-button" onclick={()=>window.dispatchEvent(new Event('sp:data-refresh'))}>Повторить загрузку рекордов</button>{/if}
 {#if !data.streams}<section class="panel"><div class="empty-small"><p>Стримы появятся автоматически после подключения площадок.</p><button class="primary" onclick={connect}>Открыть интеграции</button></div></section>{/if}
{:else}<p class="muted" role="status">Загружаем итоги…</p>{/if}

<style>.duration-part{font-size:inherit;color:inherit;line-height:inherit;white-space:nowrap}.records-heading{font-size:17px;margin:24px 0 12px}.channel-records{grid-template-columns:repeat(2,minmax(0,1fr));margin-top:0}.channel-records small{color:var(--muted)}</style>
