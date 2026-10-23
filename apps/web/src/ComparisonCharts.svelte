<script lang="ts">
 import type {Snippet} from 'svelte';
 import {date} from './api';
 import AudienceGrowth from './AudienceGrowth.svelte';
 import type {GrowthStream} from './audience-growth';
 interface ComparisonStream extends GrowthStream {title?:string;audience:number;returning:number}
 let {showGrowth=true,scope,categoryFilter,streams,timezone,onStream}:{showGrowth?:boolean;scope?:string;categoryFilter:Snippet<[string]>;streams:ComparisonStream[];timezone:string;onStream:(id:string)=>void}=$props();
 let page=$state(0);
 $effect(()=>{void scope;page=0;});
 const displayed=$derived([...streams].sort((a,b)=>b.startedAt-a.startedAt).slice(page*100,(page+1)*100));
 const comparisons=$derived([
  {title:'Возвращаемость по эфирам',unit:'%',rows:displayed.map(s=>({label:date(s.startedAt).split(',')[0]!,value:s.audience?s.returning*100/s.audience:null,detail:`${s.returning} из ${s.audience} участников`}))},

 ]);
</script>
{#if streams.length>100}<div class="analytics-controls"><button class="outline" disabled={page===0} onclick={()=>page--}>Назад</button><span>Сравнение: страница {page+1}</span><button class="outline" disabled={(page+1)*100>=streams.length} onclick={()=>page++}>Далее</button></div>{/if}
<div class="comparison-charts">
 {#each comparisons as chart}<section class="panel"><header><h3>{chart.title}</h3></header>{@render categoryFilter(`Категория: ${chart.title}`)}<div class="comparison-bars">
  {#each chart.rows as row}<div class="comparison-row"><div><span>{row.label}</span><strong>{row.value===null?'Нет данных':`${row.value.toLocaleString('ru-RU',{maximumFractionDigits:1})} ${chart.unit}`}</strong></div><div class="track"><i style:width={`${row.value===null?0:Math.max(0,row.value)/Math.max(1,...chart.rows.map(r=>r.value??0))*100}%`}></i></div><small class="muted">{row.detail}</small></div>{:else}<p class="muted">Нужны собранные эфиры.</p>{/each}
 </div></section>{/each}
</div>
{#if showGrowth}<AudienceGrowth {categoryFilter} {streams} {timezone} {onStream}/>{/if}
<style>.comparison-charts{padding:10px 12px;border-left:2px solid var(--border);margin-left:10px}.comparison-charts .panel{border:0;background:transparent}.comparison-charts header{padding:6px 8px;border:0}.comparison-charts h3{font-size:13px;margin:0}.comparison-bars{padding:8px!important}.comparison-charts{display:grid;grid-template-columns:1fr;gap:16px}.comparison-bars{padding:14px 16px;max-height:320px;overflow:auto}.comparison-row{margin-bottom:16px}.comparison-row:last-child{margin-bottom:0}.comparison-row>div:first-child{display:flex;gap:10px;justify-content:space-between;align-items:baseline;font-size:12px}.comparison-row span{min-width:0;overflow-wrap:anywhere}.comparison-row strong{flex-shrink:0;font-size:12px}.track{height:7px;background:#242a34;border-radius:4px;margin:8px 0}.track i{display:block;height:100%;border-radius:4px;background:var(--teal)}@media(max-width:1000px){.comparison-charts{grid-template-columns:1fr}.comparison-charts .panel{margin-bottom:0}.comparison-charts{margin-bottom:16px}}</style>
