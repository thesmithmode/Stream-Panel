<script lang="ts">
 import {date} from './api';
 import Icon from './Icon.svelte';
 import AudienceGrowth from './AudienceGrowth.svelte';
 import type {StreamMetric as GrowthStream} from './daily-metrics';
 interface ComparisonStream extends GrowthStream {title?:string;audience:number;returning:number}
 let {showGrowth=true,scope,streams,totalCount,loadStreams,timezone,onStream}:{showGrowth?:boolean;scope?:string;streams:ComparisonStream[];totalCount?:number;loadStreams?:(params:Record<string,number>,signal:AbortSignal)=>Promise<any>;timezone:string;onStream:(id:string)=>void}=$props();
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
<div class="comparison-charts">
 {#each comparisons as chart}<section class="retention-section" aria-label={chart.title}>
  {#if chart.rows.length}<table class="retention-table">
   <thead><tr><th scope="col">Эфир</th><th scope="col">Вернулись</th><th scope="col">Доля</th></tr></thead>
   <tbody>{#each chart.rows as row}<tr class="comparison-row">
    <th scope="row">{row.label}</th>
    <td>{row.detail}</td>
    <td><strong>{row.value===null?'Нет данных':`${row.value.toLocaleString('ru-RU',{maximumFractionDigits:1})} ${chart.unit}`}</strong><div class="track" aria-hidden="true"><i style:width={`${row.value===null?0:Math.min(100,Math.max(0,row.value))}%`}></i></div></td>
   </tr>{/each}</tbody>
  </table>{:else}<p class="retention-empty muted">Нужны собранные эфиры.</p>{/if}
 </section>{/each}
 {#if total>pageSize}<div class="retention-pages" aria-label="Страницы возвращаемости">
  <button class="outline" aria-label="Предыдущие эфиры" title="Предыдущие эфиры" disabled={page===0} onclick={()=>page--}><Icon name="back" size={18}/></button>
  <span>{page*pageSize+1}–{Math.min((page+1)*pageSize,total)} из {total}</span>
  <button class="outline" aria-label="Следующие эфиры" title="Следующие эфиры" disabled={(page+1)*pageSize>=total} onclick={()=>page++}><Icon name="arrow" size={18}/></button>
 </div>{/if}
</div>
{#if showGrowth}<AudienceGrowth {streams} {timezone} {onStream}/>{/if}
<style>
 .comparison-charts{min-width:0;padding:0 16px 12px}
 .retention-table{width:100%;table-layout:fixed;border-collapse:collapse;font-variant-numeric:tabular-nums}
 .retention-table th,.retention-table td{display:table-cell;padding:12px 0;border:0;border-bottom:1px solid var(--border);font-size:13px;white-space:normal;overflow-wrap:anywhere;vertical-align:middle;text-align:left;line-height:1.4}
 .retention-table thead th{font-size:12px;color:var(--muted);font-weight:400;padding-block:4px 10px}
 .retention-table th:first-child{width:36%;font-weight:400}
 .retention-table th:nth-child(2),.retention-table td:nth-child(2){width:31%;padding-inline:6px;color:var(--muted)}
 .retention-table th:last-child,.retention-table td:last-child{width:33%;text-align:right}
 .retention-table tbody th{color:var(--text)}
 .retention-table strong{font-size:14px;font-weight:600;line-height:1.4}
 .track{height:4px;background:var(--border);border-radius:4px;margin-top:6px;max-width:96px;margin-left:auto;overflow:hidden}
 .track i{display:block;height:100%;border-radius:4px;background:var(--teal)}
 .retention-pages{display:grid;grid-template-columns:44px minmax(0,1fr) 44px;align-items:center;gap:12px;margin-top:16px}
 .retention-pages button{width:44px;height:44px;min-height:44px;padding:0;border-radius:9px}
 .retention-pages span{text-align:center;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
 .retention-empty{padding:8px 0;margin:0;font-size:13px}
 @media(max-width:360px){.comparison-charts{padding-inline:12px}.retention-table th,.retention-table td{font-size:12px}.retention-table strong{font-size:13px}}
</style>
