<script lang="ts">
  import {untrack} from 'svelte';
  import {ConnectionError} from "./request";
  import StreamDonations from "./StreamDonations.svelte";
  import Insights from "./Insights.svelte";
  import Following from "./Following.svelte";
  import Help from "./Help.svelte";
  import {chartMetrics,type ChartMetric} from './chart-series';
  import AudienceChart from "./AudienceChart.svelte";
  import AudienceRanking from "./AudienceRanking.svelte";
  import {streamRange,streamTime} from './stream-time';
  import type {Session} from './api';
  import {
    api,
    money,
    type Summary,
  } from "./api";
  let {
    summary,
    sessionFilter = "",
    onPerson,
    session,changed,onStream,
  }: {
    summary: Summary;
    sessionFilter?: string;
    connect: () => void;
    onPerson: (id: string) => void;
    session?:Session|undefined;
    changed:()=>Promise<void>;
    onStream:(id:string)=>void;
  } = $props();
  let audienceData=$state<any>(null),audienceError=$state(''),audienceBusy=$state(false);
  let audienceMetric=$state<ChartMetric>('viewers');
  const viewers=$derived(audienceData?.streamComparison?.[0]?.viewers?.all);
  let resolution=$state(1);
  const decimal=(n:number)=>n.toLocaleString('ru-RU',{maximumFractionDigits:1});
  let metadata=$state<Array<{at:number;title:string;categoryName:string}>>([]);
  let audienceRequest=0,lastAudienceSession='';
  $effect(()=>{
    const current=sessionFilter;void summary;
    return untrack(()=>{
    if(current===lastAudienceSession&&(document.hidden||!navigator.onLine))return;
    const id=++audienceRequest;audienceBusy=audienceData===null;audienceError='';
    if(current!==lastAudienceSession){audienceData=null;metadata=[];lastAudienceSession=current;}
    if(!current){audienceData=null;audienceBusy=false;return;}
    const controller=new AbortController();
    void Promise.all([api(`analytics?${new URLSearchParams({session:current,source:'all',timezone:'Europe/Moscow'})}`,undefined,controller.signal),api<Array<{at:number;title:string;categoryName:string}>>(`sessions/${current}/metadata`,undefined,controller.signal)]).then(([result,history])=>{
      if(id===audienceRequest){audienceData=result;metadata=history.filter((row,i)=>!i||row.title!==history[i-1]!.title||row.categoryName!==history[i-1]!.categoryName);}
    }).catch(error=>{if(id===audienceRequest&&!(error instanceof ConnectionError)){audienceError=(error as Error).message;}}).finally(()=>{if(id===audienceRequest)audienceBusy=false;});
    return()=>{audienceRequest++;controller.abort();};
    });
  });
</script>
{#if session}<section class="panel stream-facts">
 <header><h2>{session.primaryTitle||'Описание стрима'}</h2><span>{streamRange(session.started_at_ms,session.ended_at_ms)} МСК</span></header>
 {#each session.breaks??[] as pause}<p class="small">Перерыв: {streamRange(pause.from,pause.to)} МСК</p>{/each}
 <details class="compact-details"><summary>История названий и категорий</summary>
  {#each metadata as row}<p class="small">{streamTime(row.at)}{row.categoryName&&row.categoryName!=="Категория неизвестна"?` · ${row.categoryName}`:''} · {row.title||'Без названия'}</p>{:else}<p class="small muted">Нет сохранённых метаданных.</p>{/each}

 </details>
</section>{/if}
<section class="metrics stream-metrics">
 <div class="metric"><div><span>Средние зрители</span><strong>{viewers?.mean!=null?decimal(viewers.mean):audienceBusy?'…':'Нет замеров'}</strong></div></div>
 <div class="metric"><div><span>Максимум зрителей</span><strong>{viewers?.peak??(audienceBusy?'…':'Нет замеров')}</strong></div></div>
 <div class="metric"><div><span>Сообщения</span><strong>{summary.messages.toLocaleString('ru-RU')}</strong></div></div>
 <div class="metric"><div><span>Донаты</span><strong>{Object.keys(summary.totals).length?Object.entries(summary.totals).map(([c,a])=>money(a,c)).join(' · '):'0'}</strong></div></div>
</section>
{#if sessionFilter}<StreamDonations sessionId={sessionFilter} {onPerson} {changed} />{/if}
<Insights sessionId={sessionFilter} refreshToken={summary} {onPerson} {onStream} />
<section class="panel series-panel">
  <header><h2>Зрители и чат <Help id="stream-presence" label="Об аудитории стрима" text="Счётчик зрителей поступает от площадки и включает зрителей без сообщений. Ники в чате — не подтверждение просмотра видео. Список составляется по опросам Twitch и сообщениям YouTube. Поэтому 10 зрителей и 4 ника в чате возможны одновременно. Нажмите столбец для детализации; пропуски замеров не заменяются нулём." /></h2><div class="chart-controls"><select aria-label="Показатель графика стрима" bind:value={audienceMetric}>{#each chartMetrics as choice}<option value={choice.value}>{choice.label}</option>{/each}</select><select aria-label="Детализация графика" bind:value={resolution}><option value={1}>1м</option><option value={5}>5м</option><option value={15}>15м</option></select></div></header>
  {#if audienceError}<p class="notice error" role="alert">{audienceError}</p>{:else if audienceData}
    <AudienceChart points={audienceData.timeline} audience={audienceData.audience} metric={audienceMetric} {resolution} showResolution={false} showRegulars={true} {onPerson}/>
  {:else}<p class="empty-small" role="status">{audienceBusy?'Загружаем график…':'Выберите стрим'}</p>{/if}
</section>
<div class="stream-details-grid"><AudienceRanking people={audienceData?.audience??[]} {onPerson} showIntervals streamStart={session?.started_at_ms??0} streamEnd={session?.ended_at_ms??Date.now()}/>
{#if sessionFilter}<Following sessionId={sessionFilter} {onPerson} />{/if}</div>
<style>.series-panel header{flex-wrap:wrap;gap:12px}.chart-controls{display:flex;gap:8px;min-width:0}.chart-controls select{border-radius:999px;width:auto;max-width:100%;padding:8px 30px 8px 12px;font-size:13px}.chart-controls select:first-child{min-width:0;flex:1}.chart-controls select:last-child{flex-shrink:0}.stream-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}@media(max-width:600px){.chart-controls{width:100%;justify-content:space-between}}.stream-details-grid{display:grid;grid-template-columns:1fr;gap:20px;margin-bottom:20px;align-items:start}@media(max-width:900px){.stream-details-grid{grid-template-columns:1fr}}</style>
