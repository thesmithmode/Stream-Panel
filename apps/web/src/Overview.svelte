<script lang="ts">
  import Icon from "./Icon.svelte";
  import Help from "./Help.svelte";
  import EventList from "./EventList.svelte";
  import { onMount } from "svelte";
  import {
    api,
    money,
    date,
    type Event,
    type Summary,
    type InsightCard,
  } from "./api";
  let {
    summary,
    events,
    status,
    sessionFilter = "",
    connect,
    onPerson,
  }: {
    summary: Summary;
    events: Event[];
    status: any;
    sessionFilter?: string;
    connect: () => void;
    onPerson: (id: string) => void;
  } = $props();
  let filter = $state("all");
  let insightsOpen = $state(false);
  let insights = $state<InsightCard[]>([]);
  let insightsLoading = $state(false);
  let insightsError = $state("");
  const visible = $derived(
    events.filter((e) => filter === "all" || e.type === filter),
  );
  const maxChatters = $derived(
    Math.max(1, ...(summary.chattersOverTime ?? []).map((p) => p.chatters)),
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
    return `${Math.round(c.ratio * 100)}% (${c.knownMinutes}/${c.totalMinutes} мин)`;
  }
</script>

<section class="metrics">
  <div class="metric">
    <Icon name="chat" size={27} />
    <div>
      <span>Сообщения</span><strong
        >{summary.messages.toLocaleString("ru-RU")}</strong
      >
      {#if summary.messagesPerMinuteOfSession != null}<small
          >{summary.messagesPerMinuteOfSession.toLocaleString("ru-RU")} сообщ./мин
          сессии</small
        >{/if}
    </div>
  </div>
  <div class="metric">
    <span class="teal"><Icon name="people" size={27} /></span>
    <div>
      <span>Наблюдаемые участники</span><strong
        >{summary.chatters != null
          ? summary.chatters
          : "нет данных"}</strong
      >{#if summary.lastPollAtMs}<small
          >Опрос: {date(summary.lastPollAtMs)}</small
        >{:else}<small>эфир не идёт / нет опросов присутствия</small>{/if}
      {#if summary.uniquePersonsObserved != null}<small
          >Уникальных за сессию: {summary.uniquePersonsObserved}</small
        >{/if}
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
          : "Нет данных"}</strong
      >
    </div>
  </div>
</section>
<section class="metrics secondary-metrics">
  <div class="metric">
    <div>
      <span>Уникальные люди (события)</span><strong
        >{(summary.uniquePersons ?? 0).toLocaleString("ru-RU")}</strong
      >
    </div>
  </div>
  <div class="metric">
    <div>
      <span>Покрытие опросов</span><strong>{coverageLabel()}</strong>
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
  <header>
    <h2>Наблюдаемые участники по опросам</h2>
    <span class="small muted">Не просмотры Twitch — только chatters poll</span>
  </header>
  {#if summary.chattersOverTime?.length}
    <div class="spark-bars" aria-label="Ряд наблюдаемых участников">
      {#each summary.chattersOverTime as point}<div
          class="spark-bar"
          title={`${date(point.atMs)}: ${point.chatters}`}
          style={`height:${Math.max(8, Math.round((point.chatters / maxChatters) * 64))}px`}
        ></div>{/each}
    </div>
  {:else}
    <p class="empty-small presence-empty">нет данных — эфир не идёт</p>
  {/if}
</section>
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
  <aside class="right-rail">
    <section class="panel">
      <header><h2>Источники</h2></header>
      {#each [["twitch", "Twitch", "TW"], ["donationalerts", "DonationAlerts", "DA"]] as const as [key, label, mark]}<div
          class="source-row"
        >
          <div class:da={key === "donationalerts"} class="source-mark">
            {mark}
          </div>
          <div class="source-content">
            <strong>{label}</strong>
            {#if status?.[key]?.state === "error"}<span
                role="alert"
                class="notice error"
                >Войди снова — {status?.[key]?.detail || "авторизация сброшена"}</span
              >{:else}<span class="small muted"
                >{status?.[key]?.detail || "Не подключён"}</span
              >{/if}
          </div>
          <button class="outline small" onclick={connect}
            >{status?.[key]?.state === "error"
              ? "Войти снова"
              : status?.[key]?.state === "connected"
                ? "Интеграции"
                : "Подключить"}</button
          >
        </div>{/each}
    </section>
    <section class="panel presence-explain">
      <header><h2>Присутствие в чате</h2></header>
      <div>
        <Icon name="people" size={42} />
        {#if summary.chatters == null && !summary.lastPollAtMs}
          <p><strong>нет данных</strong></p>
          <p class="small muted">эфир не идёт — опросы присутствия появятся после начала стрима.</p>
        {:else}
          <Help
            label="Подробнее о присутствии в чате"
            text="Наблюдение в чате не подтверждает просмотр видео."
            id="presence-chat-help"
          />
        {/if}
      </div>
    </section>
  </aside>
</div>
