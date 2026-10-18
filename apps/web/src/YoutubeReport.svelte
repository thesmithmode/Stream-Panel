<script lang="ts">
 import Help from './Help.svelte';
 import {date} from './api';
 let {report}:{report:{updatedAt:number;data:{start?:string;end?:string;columnHeaders?:{name:string}[];rows?:unknown[][]}}}=$props();
 let page=$state(0);
 const headers=$derived(report.data.columnHeaders??[]);
 const dayIndex=$derived(headers.findIndex(c=>c.name==='day'));
 const rows=$derived([...(report.data.rows??[])].sort((a,b)=>String(b[dayIndex]??'').localeCompare(String(a[dayIndex]??''))));
 const current=$derived(Math.min(page,Math.max(0,Math.ceil(rows.length/30)-1)));
 const names:Record<string,string>={day:'Дата',views:'Просмотры',estimatedMinutesWatched:'Минуты просмотра',subscribersGained:'Подписались',subscribersLost:'Отписались'};
 const total=(name:string)=>{const i=headers.findIndex(c=>c.name===name);return i<0?null:rows.reduce((sum,row)=>sum+(Number(row[i])||0),0);};
 const integer=(n:number|null)=>n===null?'—':Math.round(n).toLocaleString('ru-RU');
</script>
<section class="panel youtube-report">
 <header><h2>YouTube · итоги канала</h2><Help id="youtube-summary-help" label="Об итогах YouTube" text="YouTube передаёт суммарные показатели всех видео канала, включая просмотры вне прямых эфиров. Это не число зрителей стрима. Отчёт приходит с задержкой; категория Twitch к нему неприменима."/></header>
 <p class="small muted period">{report.data.start??'—'} — {report.data.end??'—'} · обновлено {date(report.updatedAt)}</p>
 <div class="youtube-totals">
  <div><span>Просмотры</span><strong>{integer(total('views'))}</strong></div>
  <div><span>Часы просмотра</span><strong>{integer(total('estimatedMinutesWatched')===null?null:total('estimatedMinutesWatched')!/60)}</strong></div>
  <div><span>Подписались</span><strong>{integer(total('subscribersGained'))}</strong></div>
  <div><span>Отписались</span><strong>{integer(total('subscribersLost'))}</strong></div>
 </div>
 <details><summary>По дням · сначала новые</summary><div class="table-wrap"><table class="analytics-table"><thead><tr>{#each headers as column}<th>{names[column.name]??column.name}</th>{/each}</tr></thead><tbody>{#each rows.slice(current*30,(current+1)*30) as row}<tr>{#each row as value,index}<td data-label={names[headers[index]?.name??'']??headers[index]?.name??''}>{headers[index]?.name==='day'?String(value):typeof value==='number'?integer(value):String(value??'—')}</td>{/each}</tr>{/each}</tbody></table></div>
 {#if rows.length>30}<div class="controls"><button class="outline" disabled={current===0} onclick={()=>page=current-1}>Новые дни</button><span>Страница {current+1} из {Math.ceil(rows.length/30)}</span><button class="outline" disabled={(current+1)*30>=rows.length} onclick={()=>page=current+1}>Предыдущие дни</button></div>{/if}
 {#if !rows.length}<p class="small period">Нет данных за этот период.</p>{/if}</details>
</section>
<style>
 .period{padding:0 20px}.youtube-totals{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;padding:16px 20px}.youtube-totals>div{display:grid;gap:8px}.youtube-totals span{font-size:12px;color:var(--muted)}.youtube-totals strong{font-size:24px}summary{padding:16px 20px;cursor:pointer;font-size:13px}.controls{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:16px 20px}@media(max-width:600px){.youtube-totals{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
