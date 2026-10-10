<script lang="ts">
 import {untrack,onMount} from 'svelte';
 import {api,money,date,type Event} from './api';
 import {formatDuration} from './duration';
 import AudienceChart from './AudienceChart.svelte';
 import AudienceRanking from './AudienceRanking.svelte';
 import EventList from './EventList.svelte';
 import Help from './Help.svelte';
 import type {ChartMetric} from './chart-series';
 let metric=$state<ChartMetric>('observed');
 let {events,onPerson,onStream,connect}:{events:Event[];onPerson:(id:string)=>void;onStream:(id:string)=>void;connect:()=>void}=$props();
 const local=(at:number)=>{const d=new Date(at);return new Date(at-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
 let from=$state(local(Date.now()-30*86400000)),to=$state(local(Date.now())),data=$state<any>(null),error=$state(''),busy=$state(false),filter=$state('all'),endNow=$state(true);
 let request=0;
 const visible=$derived(events.filter(e=>filter==='all'||e.type===filter));
 const totals=$derived.by(()=>{const sums:Record<string,string>={};for(const p of data?.audience??[])for(const [currency,amount] of Object.entries(p.donations))sums[currency]=(BigInt(sums[currency]??'0')+BigInt(String(amount))).toString();return sums;});
 const minutes=$derived((data?.categories??[]).reduce((n:number,c:any)=>n+c.minutes,0));
 function preset(days:number|'all'){endNow=true;from=local(days==='all'?0:Date.now()-days*86400000);to=local(Date.now());}
 async function refresh(){const id=++request;busy=true;error='';try{const result=await api(`analytics?${new URLSearchParams({from:String(new Date(from).getTime()),to:String(endNow?Date.now():new Date(to).getTime()),source:'all',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})}`);if(id===request)data=result;}catch(e){if(id===request){error=(e as Error).message;data=null;}}finally{if(id===request)busy=false;}}
 $effect(()=>{from;to;endNow;data=null;const timer=setTimeout(()=>untrack(()=>void refresh()),250);return()=>{clearTimeout(timer);request++;};});
onMount(()=>{const timer=setInterval(()=>{if(endNow&&!busy)void refresh();},60000);return()=>{request++;clearInterval(timer);};});
</script>
<section class="panel">
 <header><h2>Статистика канала</h2><div class="presets">{#each [7,30,90,180,365] as days}<button class="outline small" onclick={()=>preset(days)}>{days===365?'Год':`${days} дней`}</button>{/each}<button class="outline small" onclick={()=>preset('all')}>Вся история</button></div></header>
 <div class="period"><label>Начало периода обзора<input type="datetime-local" bind:value={from}/></label><label>Конец периода обзора<input type="datetime-local" bind:value={to} onchange={()=>endNow=false}/></label></div>
 {#if busy}<p role="status">Обновляем обзор…</p>{/if}{#if error}<p role="alert">{error}</p>{/if}
</section>
{#if data}
 <section class="metrics channel-metrics" aria-label="Статистика канала за период">
  <div class="metric"><div><span>Стримы</span><strong>{data.summary.streams}</strong></div></div>
  <div class="metric"><div><span>Время эфиров</span><strong>{formatDuration(minutes)}</strong></div></div>
  <div class="metric"><div><span>Участники чата</span><strong>{data.summary.attendees}</strong></div></div>
  <div class="metric"><div><span>Сообщения</span><strong>{data.summary.messages}</strong></div></div>
  <div class="metric"><div><span>Ядро аудитории</span><strong>{data.summary.core}</strong></div></div>
  <div class="metric"><div><span>Донаты</span>{#each Object.entries(totals) as [currency,amount]}<strong>{money(amount,currency)}</strong>{:else}<strong>—</strong>{/each}</div></div>
 </section>
 <section class="panel"><header><h2>Аудитория в чате <Help id="channel-presence" label="О данных аудитории" text="Twitch показывает наблюдения присутствия, YouTube — активность сообщений. Эти сигналы не подтверждают просмотр видео. Нажмите столбец, чтобы увидеть участников; неизвестные периоды не считаются нулём."/></h2><label>Метрика графика<select bind:value={metric}><option value="observed">Участники Twitch</option><option value="estimated">Оценка YouTube</option><option value="messages">Сообщения</option><option value="viewers">Счётчик площадки</option></select></label></header><AudienceChart points={data.timeline} audience={data.audience} {metric} resolution={0} {onPerson}/></section>
 <AudienceRanking people={data.audience} {onPerson}/>
 <section class="panel"><header><h2>Стримы за период</h2></header><div class="stream-list">{#each [...data.streamComparison].reverse() as stream}<button class="outline stream" onclick={()=>onStream(stream.id)}><span>{stream.title||'Стрим'}</span><span class="small muted">{date(stream.startedAt)} · {stream.messages} сообщений</span></button>{:else}<p class="muted">Стримов за этот период нет</p>{/each}</div></section>
{/if}
<section class="panel"><header><h2>Последние события</h2><select aria-label="Фильтр событий" bind:value={filter}><option value="all">Все события</option><option value="chat.message">Сообщения</option><option value="donation">Донаты</option></select></header>{#if visible.length}<EventList events={visible} {onPerson}/>{:else if events.length}<p>Событий этого типа нет</p>{:else}<p>Новые события появятся после подключения площадок.</p><button class="primary" onclick={connect}>Открыть интеграции</button>{/if}</section>
<style>.period{display:flex;gap:1rem;flex-wrap:wrap;}label{display:grid;gap:.4rem;flex:1;min-width:180px;}input{min-width:0;width:100%;box-sizing:border-box;}.presets{display:flex;gap:.4rem;flex-wrap:wrap;}.channel-metrics{grid-template-columns:repeat(3,minmax(0,1fr));}.stream-list{display:grid;gap:.5rem;}.stream{display:flex;justify-content:space-between;align-items:center;gap:1rem;text-align:left;white-space:normal;}.stream span{overflow-wrap:anywhere;}@media(max-width:600px){.channel-metrics{grid-template-columns:repeat(2,minmax(0,1fr));}.stream{align-items:flex-start;flex-direction:column;}.metric strong{font-size:1.3rem;}}</style>
