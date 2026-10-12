<script lang="ts">
 import {date} from './api';
 interface ComparisonStream {startedAt:number;title?:string;audience?:number;returning?:number;viewers?:{all?:{mean?:number|null;peak?:number|null}}}
 interface ComparisonCategory {name:string;minutes?:number;sessions?:number;messagesPerHour?:number|null}
 let {streams,categories}:{streams:ComparisonStream[];categories:ComparisonCategory[]}=$props();
 const comparisons=$derived([
  {title:'Когда аудитория возвращается',unit:'%',rows:streams.map(s=>({label:date(s.startedAt).split(',')[0]!,value:s.audience&&s.returning!==undefined?s.returning*100/s.audience:null,detail:`${s.returning??'—'} из ${s.audience??'—'} участников`}))},
  {title:'Какие категории оживляют чат',unit:'сообщ./ч',rows:categories.map(c=>({label:c.name,value:c.messagesPerHour??null,detail:`${c.sessions??'—'} эфиров · ${c.minutes===undefined?'—':Math.round(c.minutes)} мин`}))},
  {title:'Зрители по эфирам',unit:'в среднем',rows:streams.map(s=>({label:s.title||date(s.startedAt).split(',')[0]!,value:s.viewers?.all?.mean??null,detail:`Пик ${s.viewers?.all?.peak??'—'}`}))}
 ]);
</script>
<div class="comparison-charts">
 {#each comparisons as chart}<section class="panel"><header><h2>{chart.title}</h2></header><div class="comparison-bars">
  {#each chart.rows as row}<div class="comparison-row"><div><span>{row.label}</span><strong>{row.value===null?'Нет данных':`${row.value.toLocaleString('ru-RU',{maximumFractionDigits:1})} ${chart.unit}`}</strong></div><div class="track"><i style:width={`${row.value===null?0:Math.max(0,row.value)/Math.max(1,...chart.rows.map(r=>r.value??0))*100}%`}></i></div><small class="muted">{row.detail}</small></div>{:else}<p class="muted">Нужны собранные эфиры.</p>{/each}
 </div></section>{/each}
</div>
<style>.comparison-charts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.comparison-bars{padding:14px 16px;max-height:320px;overflow:auto}.comparison-row{margin-bottom:16px}.comparison-row:last-child{margin-bottom:0}.comparison-row>div:first-child{display:flex;gap:10px;justify-content:space-between;align-items:baseline;font-size:12px}.comparison-row span{min-width:0;overflow-wrap:anywhere}.comparison-row strong{flex-shrink:0;font-size:12px}.track{height:7px;background:#242a34;border-radius:4px;margin:8px 0}.track i{display:block;height:100%;border-radius:4px;background:var(--teal)}@media(max-width:1000px){.comparison-charts{grid-template-columns:1fr}.comparison-charts .panel{margin-bottom:0}.comparison-charts{margin-bottom:16px}}</style>
