<script lang="ts">
  import Icon from "./Icon.svelte";
  import EventList from "./EventList.svelte";
  import { money, date, type Event, type Summary } from "./api";
  let {
    summary,
    events,
    status,
    connect,
    onPerson,
  }: {
    summary: Summary;
    events: Event[];
    status: any;
    connect: () => void;
    onPerson: (id: string) => void;
  } = $props();
  let filter = $state("all");
  const visible = $derived(
    events.filter((e) => filter === "all" || e.type === filter),
  );
</script>

<section class="metrics">
  <div class="metric">
    <Icon name="chat" size={27} />
    <div>
      <span>Сообщения</span><strong
        >{summary.messages.toLocaleString("ru-RU")}</strong
      >
    </div>
  </div>
  <div class="metric">
    <span class="teal"><Icon name="people" size={27} /></span>
    <div>
      <span>Наблюдаемые участники</span><strong
        >{summary.chatters ?? "—"}</strong
      >{#if summary.lastPollAtMs}<small
          >Опрос: {date(summary.lastPollAtMs)}</small
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
        <button class="primary" onclick={connect}>Подключить сервисы</button>
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
            <strong>{label}</strong><span class="small muted"
              >{status?.[key]?.detail || "Не подключён"}</span
            >
          </div>
          <button class="outline small" onclick={connect}
            >{status?.[key]?.state === "connected"
              ? "Настроить"
              : "Подключить"}</button
          >
        </div>{/each}
    </section>
    <section class="panel presence-explain">
      <header><h2>Присутствие в чате</h2></header>
      <div>
        <Icon name="people" size={42} />
        <p>Наблюдение в чате не подтверждает просмотр видео.</p>
      </div>
    </section>
  </aside>
</div>
