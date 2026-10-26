<script lang="ts">
 import type {Snippet} from 'svelte';
 import {date} from './api';
 import AudienceGrowth from './AudienceGrowth.svelte';
 import type {StreamMetric as GrowthStream} from './daily-metrics';
 interface ComparisonStream extends GrowthStream {title?:string;audience:number;returning:number}
 let {showGrowth=true,scope,categoryFilter,streams,totalCount,loadStreams,timezone,onStream}:{showGrowth?:boolean;scope?:string;categoryFilter:Snippet<[string]>;streams:ComparisonStream[];totalCount?:number;loadStreams?:(params:Record<string,number>,signal:AbortSignal)=>Promise<any>;timezone:string;onStream:(id:string)=>void}=$props();
 let page=$state(0);
 const pageSize=7;
 $effect(()=>{void scope;page=0;});
 let fetched=$state<ComparisonStream[]|null>(null),failure=$state('');
 const total=$derived(totalCount??streams.length);
 $effect(()=>{const current=page,loader=loadStreams;void scope;fetched=null;failure='';if(!loader)return;const controller=new AbortController();
  void loader({streamOffset:current*pageSize,streamLimit:pageSize},controller.signal).then(result=>{if(!controller.signal.aborted)fetched=result.streamComparison??[];}).catch(e=>{if(!controller.signal.aborted)failure=e.message;});return()=>controller.abort();
 });
 const displayed=$derived(fetched??[...streams].sort((a,b)=>b.startedAt-a.startedAt).slice(page*pageSize,(page+1)*pageSize));
 const comparisons=$derived([
  {title:'Возвращаемость по эфирам',unit:'%',rows:displayed.map(s=>({label:date(s.startedAt).split(',')[0]!,value:s.audience?s.returning*100/s.audience:null,detail:`${s.returning} из ${s.audience}`}))},

 ]);
</script>
{#if failure}<p role="alert">{failure}</p>{/if}
{#if total>pageSize}<div class="analytics-controls"><button class="outline" disabled={page===0} onclick={()=>page--}>Назад</button><span>Сравнение: страница {page+1}</span><button class="outline" disabled={(page+1)*pageSize>=total} onclick={()=>page++}>Далее</button></div>{/if}
<div class="comparison-charts">
 {#each comparisons as chart}<section class="panel">{@render categoryFilter(`Категория: ${chart.title}`)}<div class="comparison-bars">
  {#each chart.rows as row}<div class="comparison-row"><div><span>{row.label} <small class="muted">· {row.detail}</small></span><strong>{row.value===null?'Нет данных':`${row.value.toLocaleString('ru-RU',{maximumFractionDigits:1})} ${chart.unit}`}</strong></div><div class="track"><i style:width={`${row.value===null?0:Math.min(100,Math.max(0,row.value))}%`}></i></div></div>{:else}<p class="muted">Нужны собранные эфиры.</p>{/each}
 </div></section>{/each}
</div>
{#if showGrowth}<AudienceGrowth {categoryFilter} {streams} {timezone} {onStream}/>{/if}
<style>
.comparison-charts{min-width:0}.comparison-charts .panel{border:0;background:transparent;margin:0}.comparison-bars{display:grid;gap:12px;padding:0 0 12px}.comparison-row>div:first-child{display:flex;justify-content:space-between;gap:12px;align-items:baseline;font-size:12px}.comparison-row strong{white-space:nowrap}.track{height:5px;background:var(--border);border-radius:4px;margin:5px 0}.track i{display:block;height:100%;border-radius:4px;background:var(--teal)}.comparison-row small{font-size:11px}
</style>
