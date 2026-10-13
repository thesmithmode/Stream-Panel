<script lang="ts">
  import {ConnectionError} from "./request";
  import StreamDonations from "./StreamDonations.svelte";
  import Following from "./Following.svelte";
  import Icon from "./Icon.svelte";
  import Help from "./Help.svelte";
  import EventList from "./EventList.svelte";
  import type {ChartMetric} from './chart-series';
  import AudienceChart from "./AudienceChart.svelte";
  import AudienceRanking from "./AudienceRanking.svelte";
  import {streamRange,streamTime} from './stream-time';
  import type {Session} from './api';
  import {
    api,
    money,
    type Event,
    type Summary,
    type InsightCard,
  } from "./api";
  let {
    summary,
    events,
    sessionFilter = "",
    connect,
    onPerson,
    session,changed,
  }: {
    summary: Summary;
    events: Event[];
    sessionFilter?: string;
    connect: () => void;
    onPerson: (id: string) => void;
    session?:Session|undefined;
    changed:()=>Promise<void>;
  } = $props();
  let audienceData=$state<any>(null),audienceError=$state(''),audienceBusy=$state(false),barOpen=$state(false);
  let audienceMetric=$state<ChartMetric>('viewers');
  const viewers=$derived(audienceData?.streamComparison?.[0]?.viewers?.all);
  const streamStats=$derived(audienceData?.streamComparison?.[0]);
  let resolution=$state(1);
  const decimal=(n:number)=>n.toLocaleString('ru-RU',{maximumFractionDigits:1});
  let metadata=$state<Array<{at:number;title:string;categoryName:string}>>([]);
  let audienceRequest=0,lastAudienceSession='';
  $effect(()=>{
    const current=sessionFilter;void summary;
    if(current===lastAudienceSession&&(barOpen||document.hidden||!navigator.onLine))return;
    const id=++audienceRequest;audienceBusy=audienceData===null;audienceError='';
    if(current!==lastAudienceSession){audienceData=null;metadata=[];lastAudienceSession=current;}
    if(!current){audienceData=null;audienceBusy=false;return;}
    void Promise.all([api(`analytics?${new URLSearchParams({session:current,source:'all',timezone:'Europe/Moscow'})}`),api<Array<{at:number;title:string;categoryName:string}>>(`sessions/${current}/metadata`)]).then(([result,history])=>{
      if(id===audienceRequest){audienceData=result;metadata=history.filter((row,i)=>!i||row.title!==history[i-1]!.title||row.categoryName!==history[i-1]!.categoryName);}
    }).catch(error=>{if(id===audienceRequest&&!(error instanceof ConnectionError)){audienceError=(error as Error).message;}}).finally(()=>{if(id===audienceRequest)audienceBusy=false;});
    return()=>{audienceRequest++;};
  });
  let filter = $state("all"),sourceFilter=$state("all");
  let insightsOpen = $state(false),insightsLoadedAt=0;
  let insights = $state<InsightCard[]>([]);
  let insightsLoading = $state(false);
  let insightsError = $state("");
  let filteredEvents=$state<Event[]|null>(null);
  $effect(()=>{const current=sessionFilter,type=filter;void events;let cancelled=false;filteredEvents=null;
    if(type==='all')return;
    void api<Event[]>(`events?${new URLSearchParams({session:current,type})}`).then(rows=>{if(!cancelled)filteredEvents=rows;}).catch(e=>{if(!cancelled)audienceError=e.message;});
    return()=>{cancelled=true;};
  });
  const visible = $derived(
    (filteredEvents??events).filter((e) => !e.type.startsWith('channel_points') && (filter === "all" || e.type === filter) && (sourceFilter === "all" || e.source === sourceFilter)),
  );
  async function loadInsights() {
    insightsOpen = !insightsOpen;
    if (!insightsOpen||Date.now()-insightsLoadedAt<60000) return;
    insightsLoading = true;
    insightsError = "";
    try {
      const q = sessionFilter ? `?session=${sessionFilter}` : "";
      insights = await api<InsightCard[]>(`insights${q}`);insightsLoadedAt=Date.now();
    } catch (e) {
      insightsError = (e as Error).message;
      insights = [];
    } finally {
      insightsLoading = false;
    }
  }
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
 <div class="metric"><div><span>Средние участники чата</span><strong>{streamStats?.meanParticipants!=null?decimal(streamStats.meanParticipants):audienceBusy?'…':'Нет наблюдений'}</strong></div></div>
 <div class="metric"><div><span>Максимум участников чата</span><strong>{streamStats?.peakParticipants??(audienceBusy?'…':'Нет наблюдений')}</strong></div></div>
 <div class="metric"><div><span>Сообщения</span><strong>{summary.messages.toLocaleString('ru-RU')}</strong></div></div>
 <div class="metric"><div><span>Донаты</span><strong>{Object.keys(summary.totals).length?Object.entries(summary.totals).map(([c,a])=>money(a,c)).join(' · '):'0'}</strong></div></div>
</section>
{#if sessionFilter}<StreamDonations sessionId={sessionFilter} {onPerson} {changed} />{/if}
<section class="panel insights-section">
 <header><h2>Инсайты</h2><button class="outline small" aria-expanded={insightsOpen} onclick={loadInsights}>{insightsOpen?'Скрыть':'Показать паттерны'}</button></header>
 {#if insightsOpen}<div class="insight-grid">
 {#if insightsLoading}<p class="muted" role="status">Загружаем…</p>{:else if insightsError}<p class="notice error" role="alert">{insightsError}</p>{:else if !insights.length}<p class="muted">Пока недостаточно данных для заметных паттернов.</p>{:else}{#each insights as card}<article class="insight-card"><h3>{card.title}</h3><p class="small">{card.detail}</p>{#if card.personId}<button class="outline small" onclick={()=>onPerson(card.personId!)}>Открыть человека</button>{/if}</article>{/each}{/if}
 </div>{/if}
</section>
<section class="panel series-panel">
  <header><h2>Зрители и чат <Help id="stream-presence" label="Об аудитории стрима" text="Счётчик зрителей поступает от площадки и включает зрителей без сообщений. Ники в чате — не подтверждение просмотра видео. Список составляется по опросам Twitch и сообщениям YouTube. Поэтому 10 зрителей и 4 ника в чате возможны одновременно. Нажмите столбец для детализации; пропуски замеров не заменяются нулём." /></h2><div class="chart-controls"><select aria-label="Показатель графика стрима" bind:value={audienceMetric}><option value="viewers">Зрители (все)</option><option value="participants">Участники (все)</option><option value="twitchViewers">Зрители Twitch</option><option value="youtubeViewers">Зрители YouTube</option><option value="observed">Люди в чате Twitch</option><option value="estimated">Активность чата YouTube</option><option value="messages">Сообщения</option></select><select aria-label="Детализация графика" bind:value={resolution}><option value={1}>1м</option><option value={5}>5м</option><option value={15}>15м</option></select></div></header>
  {#if audienceError}<p class="notice error" role="alert">{audienceError}</p>{:else if audienceData}
    <AudienceChart points={audienceData.timeline} audience={audienceData.audience} metric={audienceMetric} {resolution} showResolution={false} showRegulars={true} {onPerson} onselection={(open)=>barOpen=open}/>
  {:else}<p class="empty-small" role="status">{audienceBusy?'Загружаем график…':'Выберите стрим'}</p>{/if}
</section>
<div class="stream-details-grid"><AudienceRanking people={audienceData?.audience??[]} {onPerson} showIntervals streamStart={session?.started_at_ms??0} streamEnd={session?.ended_at_ms??Date.now()}/>
{#if sessionFilter}<Following sessionId={sessionFilter} {onPerson} />{/if}</div>
<div class="overview-grid">
  <section class="panel feed">
    <header>
      <h2>Лента событий</h2>
      <div class="event-filters"><select aria-label="Площадка событий" bind:value={sourceFilter}><option value="all">Все площадки</option><option value="twitch">Twitch</option><option value="youtube">YouTube</option><option value="donationalerts">DonationAlerts</option></select>
      <select aria-label="Фильтр событий" bind:value={filter}
        ><option value="all">Все события</option><option value="chat.message"
          >Сообщения</option
        ><option value="donation">Донаты</option></select
      ></div>
    </header>
    {#if events.length}<EventList
        events={visible}
        {onPerson}
        streamStart={session?.started_at_ms} streamEnd={session?.ended_at_ms??Date.now()}
      />{#if !visible.length}<p class="empty-small">
          Событий этого типа нет
        </p>{/if}{:else}<div class="empty">
        <Icon name="chat" size={62} />
        <h3>Подключите Twitch и DonationAlerts</h3>
        <p>Новые события появятся здесь.</p>
        <button class="primary" onclick={connect}>Открыть интеграции</button>
      </div>{/if}
  </section>

</div>

<style>.series-panel header{flex-wrap:wrap;gap:12px}.chart-controls{display:flex;gap:8px;min-width:0}.chart-controls select{border-radius:999px;width:auto;max-width:100%;padding:8px 30px 8px 12px;font-size:13px}.chart-controls select:first-child{min-width:0;flex:1}.chart-controls select:last-child{flex-shrink:0}.stream-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}@media(max-width:600px){.chart-controls{width:100%;justify-content:space-between}}.overview-grid{display:block}.stream-details-grid{display:grid;grid-template-columns:1fr;gap:20px;margin-bottom:20px;align-items:start}@media(max-width:900px){.stream-details-grid{grid-template-columns:1fr}}</style>
