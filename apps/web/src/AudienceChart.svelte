<script lang="ts">
 import {onDestroy} from 'svelte';
 import TrendChart from './TrendChart.svelte';
 import Help from './Help.svelte';
 import {participantsAt,type SignalParticipant} from './chart-detail';
 import {chartSeries,type ChartMetric,type ChartPoint} from './chart-series';
 let {points,audience,metric='observed',resolution=1,showRegulars=true,timezone='Europe/Moscow',onPerson,onselection}:{points:ChartPoint[];audience:SignalParticipant[];metric?:ChartMetric;resolution?:number;showRegulars?:boolean;timezone?:string;onPerson:(id:string)=>void;onselection?:(selected:boolean)=>void}=$props();
 const id=$props.id();
 let bucket=$state<ReturnType<typeof chartSeries>[number]|null>(null),minute=$state<number|null>(null);
 const minutePoints=$derived(bucket?points.filter(p=>p.at>=bucket!.at&&p.at<bucket!.at+bucket!.width):[]);
 const selected=$derived(minute===null?bucket:chartSeries(minutePoints.filter(p=>p.at===minute),metric,1)[0]??null);
 const people=$derived(selected?participantsAt(audience,selected.at,selected.at+selected.width).filter(p=>metric==='observed'?p.observed:metric==='estimated'?p.estimated:true):[]);
 const label=(at:number)=>new Date(at).toLocaleString('ru-RU',{timeZone:timezone});
 $effect(()=>{void points;void metric;void resolution;bucket=null;minute=null;});
 $effect(()=>onselection?.(bucket!==null));
 onDestroy(()=>onselection?.(false));
</script>
<TrendChart {points} {metric} {resolution} {showRegulars} {timezone} onselect={point=>{bucket=point;minute=null;}}/>
{#if selected}
 <section class="bar-detail" aria-label="Детали выбранного столбца">
  <header><h3>{label(selected.at)}{selected.width>60000?` — ${label(selected.at+selected.width)}`:''} <Help id={`${id}-help`} label="О детализации минуты" text="Список показывает персональные сигналы в выбранном интервале: наблюдения чата Twitch или оценку по сообщениям YouTube. Счётчик площадки не раскрывает личности всех зрителей. Для широкого столбца высота — среднее, а список — уникальные участники; выберите отдельную минуту. В метрике сообщений список не определяет авторов отдельных сообщений."/></h3><button class="outline small" onclick={()=>{bucket=null;minute=null;}}>Закрыть детализацию</button></header>
  {#if bucket&&bucket.width>60000}<label>Минута столбца<select bind:value={minute}><option value={null}>Весь интервал</option>{#each minutePoints as p}<option value={p.at}>{label(p.at)}</option>{/each}</select></label>{/if}
  <div class="detail-values"><span>Значение: <strong>{selected.known?selected.value.toLocaleString('ru-RU',{maximumFractionDigits:1}):'нет данных'}</strong></span><span>Участники по сигналам: <strong>{people.length}</strong></span></div>
  <ul>{#each people as person}<li><button class="text-button" onclick={()=>onPerson(person.id)}>{person.name}</button><span>{person.observed?'Twitch':''}{person.observed&&person.estimated?' · ':''}{person.estimated?'YouTube · оценка':''}</span></li>{:else}<li class="muted">Нет сохранённых персональных сигналов в этом интервале.</li>{/each}</ul>
 </section>
{/if}
<style>
 .bar-detail{margin:0 20px 20px;border:1px solid var(--border);border-radius:10px;padding:16px;}header{padding:0 0 12px!important;flex-wrap:wrap;gap:12px;}h3{margin:0;font-size:15px;}label{display:grid;gap:6px;margin-bottom:12px;}select{max-width:100%;}.detail-values{display:flex;gap:16px;flex-wrap:wrap;}ul{list-style:none;padding:0;margin:12px 0 0;display:grid;gap:8px;}li{display:flex;justify-content:space-between;gap:12px;}li button{text-align:left;white-space:normal;overflow-wrap:anywhere;}li span{font-size:12px;color:var(--muted);}
</style>
