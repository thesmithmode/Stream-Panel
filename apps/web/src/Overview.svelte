<script lang="ts">
 import ActionMenu from "./ActionMenu.svelte";
 import SectionTabs from "./SectionTabs.svelte";
  import {untrack} from 'svelte';
  import {ConnectionError} from "./request";
  import StreamDonations from "./StreamDonations.svelte";
  import RecentEvents from './RecentEvents.svelte';
  import Insights from "./Insights.svelte";
  import Following from "./Following.svelte";
  import Help from "./Help.svelte";
  import {chartMetrics,type ChartMetric} from './chart-series';
  import AudienceChart from "./AudienceChart.svelte";
  import AudienceRanking from "./AudienceRanking.svelte";
  import {compactStreamRange as streamRange,streamTime} from './stream-time';
  import type {Session} from './api';
  import {
    api,
    getProfile,
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
  const viewerMetrics=$derived(audienceData?.streamComparison?.[0]?.viewers);
  const viewers=$derived(viewerMetrics?.known?.partialMinutes?viewerMetrics.known:viewerMetrics?.all);
  const viewerPartial=$derived((viewerMetrics?.known?.partialMinutes??0)>0);
  function loadResolution(){
    try{const saved=Number(localStorage.getItem(`sp-stream-resolution-${getProfile()}`));return [1,5,15].includes(saved)?saved:5;}catch{return 5;}
  }
  let resolution=$state(loadResolution());
  function setResolution(value:number){resolution=value;try{localStorage.setItem(`sp-stream-resolution-${getProfile()}`,String(value));}catch{/* Preferences are optional. */}}
  let activeTab=$state('summary');
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
{#if session}<section class="stream-facts">
 <div class="stream-title-row"><h1>{session.primaryTitle||'Стрим'}</h1><ActionMenu variant="metadata-menu" label="История названий и категорий">{#snippet children()}
 {#if viewerPartial}<p class="small muted">Показана сумма известных зрителей площадок. Пропущенные замеры не считаются нулём.</p>{/if}
 {#each session.breaks??[] as pause}<p class="small">Перерыв: {streamRange(pause.from,pause.to)} МСК</p>{/each}
 {#each [...metadata].sort((a,b)=>b.at-a.at) as row}<p class="small">{streamTime(row.at)}{row.categoryName&&row.categoryName!=="Категория неизвестна"?` · ${row.categoryName}`:''} · {row.title||'Без названия'}</p>{:else}<p class="small muted">Нет сохранённых метаданных.</p>{/each}
 {/snippet}</ActionMenu></div>
 <p class="stream-meta">{[`${streamRange(session.started_at_ms,session.ended_at_ms)} МСК`,[...new Set(metadata.map(row=>row.categoryName).filter(name=>name&&name!=="Категория неизвестна"))].join(' · '),session.platforms?.map(p=>p==='twitch'?'Twitch':'YouTube').join(' + ')].filter(Boolean).join(' · ')}</p>
</section>{/if}
<section class="stream-kpis" aria-label="Итоги эфира">
 <div><span>Средние зрители</span><strong><span class="kpi-number">{viewers?.mean!=null?decimal(viewers.mean):audienceBusy?'…':'—'}</span></strong></div>
 <div><span>Пик зрителей</span><strong>{viewers?.peak!=null?viewers.peak:(audienceBusy?'…':'—')}</strong></div>
 <div><span>Донаты</span><strong>{Object.keys(summary.totals).length?Object.entries(summary.totals).map(([c,a])=>money(a,c)).join(' · '):'—'}</strong></div>
 <div><span>Сообщения</span><strong>{summary.messages.toLocaleString('ru-RU')}</strong></div>
</section>
<SectionTabs items={[["summary","Итоги"],["people","Участники"],["events","События"]]} bind:value={activeTab} label="Разделы эфира" panelId="stream-tabpanel"/>
<div id="stream-tabpanel" role="tabpanel" aria-label={activeTab==='summary'?'Итоги':activeTab==='people'?'Участники':'События'}>
{#if activeTab==='summary'}
<section class="panel series-panel">
  <header><h2>Зрители и чат <Help id="stream-presence" label="Об аудитории стрима" text="Счётчик зрителей поступает от площадки и включает зрителей без сообщений. Ники в чате — не подтверждение просмотра видео. Список составляется по опросам Twitch и сообщениям YouTube. Нажмите столбец для детализации; пропуски замеров не заменяются нулём." /></h2></header>
  <div class="stream-chart-toolbar">
    <select aria-label="Показатель графика стрима" bind:value={audienceMetric}>{#each chartMetrics as choice}<option value={choice.value}>{choice.label}</option>{/each}</select>
    <div class="period-chips" role="group" aria-label="Детализация графика">{#each [1,5,15] as step}<button class:active={resolution===step} aria-pressed={resolution===step} onclick={()=>setResolution(step)}>{step} мин</button>{/each}</div>
  </div>
  {#if audienceError}<p class="notice error" role="alert">{audienceError}</p>{:else if audienceData}
    <AudienceChart points={audienceData.timeline} audience={audienceData.audience} metric={audienceMetric} {resolution} showResolution={false} showRegulars={true} {onPerson}/>
  {:else}<p class="empty-small" role="status">{audienceBusy?'Загружаем график…':'Выберите стрим'}</p>{/if}
</section>

<Insights sessionId={sessionFilter} refreshToken={summary} {onPerson} {onStream} />
{#if sessionFilter}<StreamDonations sessionId={sessionFilter} {onPerson} {changed}/><details class="section-disclosure"><summary>Подписчики</summary><Following embedded sessionId={sessionFilter} {onPerson}/></details>{/if}
{:else if activeTab==='people'}
<AudienceRanking people={audienceData?.audience??[]} {onPerson} showIntervals streamStart={session?.started_at_ms??0} streamEnd={session?.ended_at_ms??Date.now()}/>
{:else if sessionFilter}<section class="panel"><header><h2>События стрима · 48 ч</h2></header><div class="settings-body"><RecentEvents sessionId={sessionFilter}/></div></section>{/if}
</div>
<style>
 .stream-title-row{display:flex;gap:16px;align-items:start}.stream-title-row h1{flex:1;min-width:0;font-size:26px;line-height:1.3;margin:0 0 12px;overflow-wrap:anywhere}.stream-meta{color:var(--muted);margin:0 0 6px;font-size:14px}.series-panel>header{display:flex;align-items:center;justify-content:space-between}
 @media(min-width:1000px){.stream-title-row h1{font-size:30px}}
</style>
