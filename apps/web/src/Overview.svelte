<script lang="ts">
 import SectionTabs from "./SectionTabs.svelte";
  import Icon from "./Icon.svelte";
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
  let resolution=$state(1);
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
 <div class="stream-title-row"><h1>{session.primaryTitle||'Стрим'}</h1><details class="metadata-menu"><summary aria-label="История названий и категорий"><Icon name="more"/></summary><div>
 <h2>История названий и категорий</h2>
 {#each session.breaks??[] as pause}<p class="small">Перерыв: {streamRange(pause.from,pause.to)} МСК</p>{/each}
 {#each [...metadata].sort((a,b)=>b.at-a.at) as row}<p class="small">{streamTime(row.at)}{row.categoryName&&row.categoryName!=="Категория неизвестна"?` · ${row.categoryName}`:''} · {row.title||'Без названия'}</p>{:else}<p class="small muted">Нет сохранённых метаданных.</p>{/each}
 </div></details></div>
 <p class="stream-meta">{streamRange(session.started_at_ms,session.ended_at_ms)} МСК</p>
 <p class="stream-meta">{[...new Set(metadata.map(row=>row.categoryName).filter(name=>name&&name!=="Категория неизвестна"))].join(' · ')}{metadata.some(row=>row.categoryName)?' · ':''}{session.platforms?.map(p=>p==='twitch'?'Twitch':'YouTube').join(' + ')}</p>
</section>{/if}
<section class="stream-kpis" aria-label="Итоги эфира">
 <div><span>Средние зрители</span><strong><span class="kpi-number">{viewers?.mean!=null?decimal(viewers.mean):audienceBusy?'…':'—'}</span>{#if viewerPartial}<Help id="stream-partial" label="Неполные данные зрителей" text="Показана сумма известных зрителей площадок. Пропущенные замеры не считаются нулём."/>{/if}</strong></div>
 <div><span>Пик зрителей</span><strong>{viewers?.peak!=null?viewers.peak:(audienceBusy?'…':'—')}</strong></div>
 <div><span>Донаты</span><strong>{Object.keys(summary.totals).length?Object.entries(summary.totals).map(([c,a])=>money(a,c)).join(' · '):'—'}</strong></div>
 <div><span>Сообщения</span><strong>{summary.messages.toLocaleString('ru-RU')}</strong></div>
</section>
<SectionTabs items={[["summary","Итоги"],["people","Участники"],["events","События"]]} bind:value={activeTab} label="Разделы эфира" panelId="stream-tabpanel"/>
<div id="stream-tabpanel" role="tabpanel" aria-label={activeTab==='summary'?'Итоги':activeTab==='people'?'Участники':'События'}>
{#if activeTab==='summary'}
<section class="panel series-panel">
  <header><h2>Зрители и чат <Help id="stream-presence" label="Об аудитории стрима" text="Счётчик зрителей поступает от площадки и включает зрителей без сообщений. Ники в чате — не подтверждение просмотра видео. Список составляется по опросам Twitch и сообщениям YouTube. Нажмите столбец для детализации; пропуски замеров не заменяются нулём." /></h2><details class="chart-options"><summary aria-label="Настроить график эфира"><Icon name="filters" size={20}/></summary><div class="chart-controls"><label>Показатель<select aria-label="Показатель графика стрима" bind:value={audienceMetric}>{#each chartMetrics as choice}<option value={choice.value}>{choice.label}</option>{/each}</select></label><label>Детализация<select aria-label="Детализация графика" bind:value={resolution}><option value={1}>1м</option><option value={5}>5м</option><option value={15}>15м</option></select></label></div></details></header>
  {#if audienceError}<p class="notice error" role="alert">{audienceError}</p>{:else if audienceData}
    <AudienceChart points={audienceData.timeline} audience={audienceData.audience} metric={audienceMetric} {resolution} showResolution={false} showRegulars={true} {onPerson}/>
  {:else}<p class="empty-small" role="status">{audienceBusy?'Загружаем график…':'Выберите стрим'}</p>{/if}
</section>
<Insights sessionId={sessionFilter} refreshToken={summary} {onPerson} {onStream} />
{#if sessionFilter}<StreamDonations sessionId={sessionFilter} {onPerson} {changed}/><details class="section-disclosure"><summary>Подписчики</summary><Following sessionId={sessionFilter} {onPerson}/></details>{/if}
{:else if activeTab==='people'}
<AudienceRanking people={audienceData?.audience??[]} {onPerson} showIntervals streamStart={session?.started_at_ms??0} streamEnd={session?.ended_at_ms??Date.now()}/>
{:else if sessionFilter}<section class="panel"><header><h2>События стрима · 48 ч</h2></header><div class="settings-body"><RecentEvents sessionId={sessionFilter}/></div></section>{/if}
</div>
<style>
 .stream-title-row{display:flex;gap:16px;align-items:start}.stream-title-row h1{flex:1;min-width:0;font-size:26px;line-height:1.3;margin:0 0 12px;overflow-wrap:anywhere}.stream-meta{color:var(--muted);margin:0 0 6px;font-size:14px}.series-panel>header{display:flex;align-items:center;justify-content:space-between}.chart-options[open]{flex-basis:100%}.chart-options summary{display:flex;justify-content:end;cursor:pointer;list-style:none}.chart-controls{display:flex;gap:12px;margin-top:12px}.chart-controls label{display:grid;gap:6px;flex:1;min-width:0;font-size:13px}.chart-controls select{width:100%;min-width:0}.metadata-menu{position:relative}.metadata-menu summary{list-style:none;cursor:pointer;min-width:44px;min-height:44px;display:grid;place-items:center}.metadata-menu>div{position:absolute;z-index:5;right:0;top:44px;width:min(360px,calc(100vw - 48px));padding:16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);box-shadow:0 12px 32px #0008}.metadata-menu h2{font-size:16px;margin-bottom:12px}
 @media(min-width:1000px){.stream-title-row h1{font-size:30px}}
</style>
