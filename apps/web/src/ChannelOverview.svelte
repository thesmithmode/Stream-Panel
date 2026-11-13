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
  <div class="metric total-streams"><div><span>Стримы</span><strong>{data.streams}</strong></div></div>
  <div class="metric total-duration"><div><span>Время эфиров</span><strong>{#each formatDuration(data.durationMinutes).split(/ (?=\d)/) as part,i}{i?' ':''}<span class="duration-part">{part}</span>{/each}</strong><small>({formatHours(data.durationMinutes)})</small></div></div>
  <div class="metric total-attendees"><div><span>Участники чата</span><strong>{data.attendees}</strong></div></div>
  <div class="metric total-messages"><div><span>Сообщения</span><strong>{data.messages.toLocaleString('ru-RU')}</strong></div></div>
  <div class="donation-summary">
  <div class="metric"><div><span>Донаты</span><strong>{data.donations}</strong></div></div>
  <div class="metric"><div><span>Сумма донатов · RUB</span>{#each Object.entries(data.totals) as [currency,amount]}<strong>{money(amount,currency)}</strong>{:else}<strong>—</strong>{/each}</div></div>
  </div>
 </section>
 {#if data.pendingExchangeDonations}<p class="small muted" role="status">Донаты без пересчёта: {data.pendingExchangeDonations}. Ожидается курс ЦБ или уточнение даты; пока они не включены в рублёвую сумму.</p>{/if}
 <h2 class="records-heading">Рекорды</h2>
 <section class="metrics channel-records" aria-label="Рекорды канала">
  {#each [['online','Средний онлайн'],['messages','Сообщения'],['peakOnline','Пик зрителей'],['peakChat','Пик участников чата']] as [key,label]}{@const record=data.records?.[key as 'online'|'messages'|'peakOnline'|'peakChat']}
   <div class="metric"><div><span>{label}</span><strong>{record?num(record.value):'—'}</strong><small>{record?recordDate(record.at):'Нет данных'}</small></div></div>
  {/each}
  <div class="metric"><div><span>Максимальный донат · RUB</span><strong>{data.maximumDonation?money(data.maximumDonation.amount,'RUB'):'—'}</strong><small>{#if data.maximumDonation}{data.maximumDonation.name??'Аноним'} · {data.maximumDonation.at===null?'Дата неизвестна':recordDate(data.maximumDonation.at)}{:else}Нет данных{/if}</small></div></div>
 </section>
 {#if !data.streams}<section class="panel"><div class="empty-small"><p>Стримы появятся автоматически после подключения площадок.</p><button class="primary" onclick={connect}>Открыть интеграции</button></div></section>{/if}
{:else}<p class="muted" role="status">Загружаем итоги…</p>{/if}

<style>.duration-part{font-size:inherit;color:inherit;line-height:inherit;white-space:nowrap}.channel-records{grid-template-columns:repeat(2,minmax(0,1fr))}.channel-records small{color:var(--muted);overflow-wrap:anywhere}.channel-records strong{overflow-wrap:anywhere}

 .channel-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:12px 0 24px}
 .channel-metrics .metric,.channel-records .metric{min-height:0;padding:14px 16px;background:var(--surface);border:1px solid var(--border);border-radius:12px}
 .channel-metrics .metric>div,.channel-records .metric>div{gap:5px}
 .channel-metrics .metric span,.channel-records .metric span{font-size:13px;line-height:1.4}
 .channel-metrics .metric strong,.channel-records .metric strong{font-size:25px;line-height:1.2;letter-spacing:-.4px}
 .channel-metrics .metric small,.channel-records .metric small{font-size:12px;line-height:1.4}
 .channel-metrics .metric strong .duration-part{font-size:inherit;color:inherit;line-height:inherit}
 .total-streams{grid-column:1;grid-row:1}.total-attendees{grid-column:2;grid-row:1}.total-messages{grid-column:3;grid-row:1}
 .total-duration{grid-column:1/-1;grid-row:2}
 .donation-summary{grid-column:1/-1;display:grid;grid-template-columns:minmax(90px,1fr) minmax(0,2fr);border:1px solid var(--border);border-radius:12px;background:var(--surface);padding:14px 0}
 .donation-summary .metric{border:0;border-radius:0;padding:0 16px;background:none}
 .donation-summary .metric+.metric{border-left:1px solid var(--border)}
 .channel-records{gap:10px;margin:0}
 .channel-records>.metric:last-child{grid-column:1/-1}
 .records-heading{margin:0 0 12px;font-size:18px}
 @media(min-width:1000px){
  .channel-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}
  .total-streams{grid-column:1;grid-row:1}.total-attendees{grid-column:2;grid-row:1}.total-messages{grid-column:3;grid-row:1}
  .total-duration{grid-column:1;grid-row:2}.donation-summary{grid-column:2/4;grid-row:2}
  .channel-records{grid-template-columns:repeat(4,minmax(0,1fr))}
  .channel-records>.metric:last-child{grid-column:1/-1}
  .channel-records>.metric:last-child>div{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1fr);align-items:center;gap:16px}
  .channel-records>.metric:last-child small{text-align:right}
 }
 @media(max-width:400px){
  .channel-metrics .metric,.channel-records .metric{padding:12px}
  .channel-metrics .metric span,.channel-records .metric span{font-size:12px}
  .channel-metrics .metric strong,.channel-records .metric strong{font-size:22px}
  .donation-summary .metric{padding:0 12px}
 }
 @media(max-width:360px){.channel-metrics>.metric:not(.total-duration)>div>span{min-height:2.8em}}
</style>
