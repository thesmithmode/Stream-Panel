<script lang="ts">
  import Following from "./Following.svelte";
  import Icon from "./Icon.svelte";
  import Help from "./Help.svelte";
  import EventList from "./EventList.svelte";
  import type {ChartMetric} from './chart-series';
  import AudienceChart from "./AudienceChart.svelte";
  import AudienceRanking from "./AudienceRanking.svelte";
  import {streamRange,streamTime} from './stream-time';
  import type {Session} from './api';
  import { onMount } from "svelte";
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
    session,
  }: {
    summary: Summary;
    events: Event[];
    sessionFilter?: string;
    connect: () => void;
    onPerson: (id: string) => void;
    session?:Session|undefined;
  } = $props();
  let audienceData=$state<any>(null),audienceError=$state(''),audienceBusy=$state(false),barOpen=$state(false);
  let audienceMetric=$state<ChartMetric>('twitchViewers');
  const viewers=$derived(audienceData?.streamComparison?.[0]?.viewers?.twitch);
  const youtubeViewers=$derived(audienceData?.streamComparison?.[0]?.viewers?.youtube);
  const lastViewers=$derived(audienceData?.timeline?.findLast((p:any)=>p.twitchViewers!=null)?.twitchViewers);
  const decimal=(n:number)=>n.toLocaleString('ru-RU',{maximumFractionDigits:1});
  let metadata=$state<Array<{at:number;title:string;categoryName:string}>>([]);
  let audienceRequest=0,lastAudienceSession='';
  $effect(()=>{
    const current=sessionFilter;void summary;
    if(current===lastAudienceSession&&barOpen)return;
    const id=++audienceRequest;audienceBusy=audienceData===null;audienceError='';
    if(current!==lastAudienceSession){audienceData=null;metadata=[];lastAudienceSession=current;}
    if(!current){audienceData=null;audienceBusy=false;return;}
    void Promise.all([api(`analytics?${new URLSearchParams({session:current,source:'all',timezone:'Europe/Moscow'})}`),api<Array<{at:number;title:string;categoryName:string}>>(`sessions/${current}/metadata`)]).then(([result,history])=>{
      if(id===audienceRequest){audienceData=result;metadata=history.filter((row,i)=>!i||row.title!==history[i-1]!.title||row.categoryName!==history[i-1]!.categoryName);}
    }).catch(error=>{if(id===audienceRequest){audienceError=(error as Error).message;}}).finally(()=>{if(id===audienceRequest)audienceBusy=false;});
    return()=>{audienceRequest++;};
  });
  let filter = $state("all");
  let insightsOpen = $state(false);
  let insights = $state<InsightCard[]>([]);
  let insightsLoading = $state(false);
  let insightsError = $state("");
  const visible = $derived(
    events.filter((e) => filter === "all" || e.type === filter),
  );
  async function loadInsights() {
    insightsOpen = !insightsOpen;
    if (!insightsOpen) return;
    insightsLoading = true;
    insightsError = "";
    try {
      const q = sessionFilter ? `?session=${sessionFilter}` : "";
      insights = await api<InsightCard[]>(`insights${q}`);
    } catch (e) {
      insightsError = (e as Error).message;
      insights = [];
    } finally {
      insightsLoading = false;
    }
  }
  function closeInsights() {
    insightsOpen = false;
  }
  onMount(() => {
    const onPointer = (event: PointerEvent) => {
      if (!insightsOpen) return;
      const target = event.target as Node | null;
      const root = document.querySelector(".insights-wrap");
      if (root && target && !root.contains(target)) closeInsights();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && insightsOpen) closeInsights();
    };
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  });
  function coverageLabel() {
    const c = summary.coverage;
    if (!c || c.ratio === null) return "—";
    return `${Math.round(c.ratio * 100)}% (${decimal(c.knownMinutes)}/${decimal(c.totalMinutes)} мин)`;
  }
</script>
{#if session}<section class="panel stream-facts">
 <header><h2>{session.primaryTitle||'Описание стрима'}</h2><span>{streamRange(session.started_at_ms,session.ended_at_ms)} МСК</span></header>
 {#each session.breaks??[] as pause}<p class="small">Перерыв: {streamRange(pause.from,pause.to)} МСК</p>{/each}
 <details class="compact-details"><summary>История названий и категорий</summary>
  {#each metadata as row}<p class="small">{streamTime(row.at)} · {row.categoryName||'Категория неизвестна'} · {row.title||'Без названия'}</p>{:else}<p class="small muted">Нет сохранённых метаданных.</p>{/each}
  <p class="small muted">Текст уведомления о начале эфира публичный Twitch API не отдаёт.</p>
 </details>
</section>{/if}
<section class="metrics">
  <div class="metric">
    <Icon name="chat" size={27} />
    <div>
      <span>Сообщения</span><strong
        >{summary.messages.toLocaleString("ru-RU")}</strong
      >
      {#if summary.messagesPerMinuteOfSession != null}<small
          >{summary.messagesPerMinuteOfSession.toLocaleString("ru-RU")} сообщ./мин
          эфира</small
        >{/if}
    </div>
  </div>
  <div class="metric">
    <span class="teal"><Icon name="people" size={27} /></span>
    <div>
      <span>Среднее число зрителей Twitch</span><strong>{viewers?.mean!=null?decimal(viewers.mean):audienceBusy?'…':'Нет замеров'}</strong>
      {#if viewers?.peak!=null}<small>Максимум: {viewers.peak}</small>{/if}
      {#if lastViewers!=null}<small>Последний замер: {lastViewers}</small>{/if}
    </div>
  </div>
  <div class="metric">
    <Icon name="heart" size={27} />
    <div>
      <span>Донаты</span><strong class:muted={!summary.donations}
        >{Object.keys(summary.totals).length
          ? Object.entries(summary.totals)
              .map(([c, a]) => money(a, c))
              .join(" · ")
          : "Нет донатов"}</strong
      >
    </div>
  </div>
</section>
{#if youtubeViewers?.mean!=null}<section class="metrics"><div class="metric"><div><span>Среднее число зрителей YouTube</span><strong>{decimal(youtubeViewers.mean)}</strong><small>Максимум: {youtubeViewers.peak}</small></div></div></section>{/if}
{#if sessionFilter}<Following sessionId={sessionFilter} {onPerson} />{/if}
<section class="metrics secondary-metrics">
  <div class="metric">
    <div>
      <span>Писали в чате</span><strong
        >{(summary.participants?.length ?? 0).toLocaleString("ru-RU")}</strong
      >
      <small>Уникальные авторы сообщений</small>
    </div>
  </div>
  <div class="metric"><div><span>Людей в чате Twitch за стрим</span><strong>{summary.uniquePersonsObserved??'Нет опросов'}</strong><small>Уникальные люди по опросам чата, не зрители видео</small></div></div>
  <div class="metric"><div>
      <span>Полнота наблюдений</span><strong>{coverageLabel()}</strong>
      {#if (summary.gapCount ?? 0) > 0}<small class="gap-badge"
          >Пропуски сбора: {summary.gapCount}</small
        >{/if}
    </div>
  </div>
  <div class="metric insights-metric">
    <div class="insights-wrap">
      <span>Инсайты</span>
      <button
        type="button"
        class="outline small insights-toggle"
        aria-expanded={insightsOpen}
        aria-haspopup="dialog"
        onclick={loadInsights}
        >{insightsOpen ? "Скрыть" : "Показать паттерны"}</button
      >
      {#if insightsOpen}<div class="insights-popover" role="dialog" aria-label="Инсайты">
          {#if insightsLoading}<p class="small muted">Считаем…</p>
          {:else if insightsError}<p class="notice error" role="alert"
              >{insightsError}</p
            >
          {:else if !insights.length}<p class="empty-small">
              Пока нет заметных паттернов по текущим данным.
            </p>
          {:else}{#each insights as card}<article class="insight-card">
                <strong>{card.title}</strong>
                <p class="small">{card.detail}</p>
                {#if card.personId}<button
                    type="button"
                    class="outline small"
                    onclick={() => onPerson(card.personId!)}>Открыть человека</button
                  >{/if}
              </article>{/each}{/if}
        </div>{/if}
    </div>
  </div>
</section>
<section class="panel series-panel">
  <header><label>График<select aria-label="Показатель графика стрима" bind:value={audienceMetric}><option value="twitchViewers">Зрители Twitch</option><option value="youtubeViewers">Зрители YouTube</option><option value="observed">Люди в чате Twitch</option><option value="estimated">Активность чата YouTube</option><option value="messages">Сообщения</option></select></label><h2>Зрители и чат <Help id="stream-presence" label="Об аудитории стрима" text="Счётчик зрителей поступает от площадки и включает зрителей без сообщений. Ники — отдельные сигналы чата: опросы Twitch или сообщения YouTube. Поэтому 10 зрителей и 4 ника в чате возможны одновременно. Нажмите столбец для детализации; пропуски замеров не заменяются нулём." /></h2></header>
  {#if audienceError}<p class="notice error" role="alert">{audienceError}</p>{:else if audienceData}
    <AudienceChart points={audienceData.timeline} audience={audienceData.audience} metric={audienceMetric} resolution={1} showRegulars={false} {onPerson} onselection={(open)=>barOpen=open}/>
  {:else}<p class="empty-small" role="status">{audienceBusy?'Загружаем график…':'Выберите стрим'}</p>{/if}
</section>
<AudienceRanking people={audienceData?.audience??[]} {onPerson} showIntervals/>
<div class="overview-grid">
  <section class="panel feed">
    <header>
      <h2>Лента событий</h2>
      <select aria-label="Фильтр событий" bind:value={filter}
        ><option value="all">Все события</option><option value="chat.message"
          >Сообщения</option
        ><option value="donation">Донаты</option></select
      >
    </header>
    {#if events.length}<EventList
        events={visible}
        {onPerson}
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

<style>.overview-grid{display:block;}</style>
