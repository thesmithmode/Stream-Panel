<script lang="ts">
  import {
    api,
    date,
    money,
    type Person,
    type Session,
    type Event,
    type PersonStats,
    type PersonTop,
  } from "./api";
  import { formatDuration } from "./duration";
  import EventList from "./EventList.svelte";
  import Icon from "./Icon.svelte";
  let {
    people,
    sessions,
    sessionFilter = "",
    initialId = "",
    onChange,
  }: {
    people: Person[];
    sessions: Session[];
    sessionFilter?: string;
    initialId?: string;
    onChange: () => Promise<void>;
  } = $props();
  let search = $state(""),
    selectedId = $state(""),
    detail = $state<any>(null),
    stats = $state<PersonStats | null>(null),
    error = $state(""),
    name = $state(""),
    target = $state(""),
    selectedIdentities = $state<string[]>([]),
    splitName = $state(""),
    gridSession = $state(""),
    grid = $state<{ minuteStartMs: number; state: string }[]>([]),
    gridLoaded = $state(false),
    merges = $state<any[]>([]),
    candidates = $state<string[]>([]),
    busy = $state(false),
    minute = $state<number | null>(null),
    sortBy = $state<"default" | "messages" | "donations" | "observed_minutes">(
      "default",
    ),
    tops = $state<PersonTop[]>([]);
  let searchResults = $state<Person[]>([]);
  const visible = $derived(
    sortBy === "default"
      ? search.trim()
        ? searchResults.filter(p=>!p.is_bot)
        : people.filter(p=>!p.is_bot)
      : tops.map(
          (t) =>
            ({
              id: t.id,
              display_name: t.display_name,
              revision: t.revision,
              event_count:
                sortBy === "messages"
                  ? t.messageCount
                  : sortBy === "donations"
                    ? t.donationCount
                    : t.observedMinutes,
              sources: t.sources,
            }) as Person,
        ),
  );
  $effect(() => {
    const term = search.trim();
    let cancelled = false;
    if (!term || sortBy !== "default") {
      searchResults = [];
      return;
    }
    const timer = setTimeout(() => {
      void api<Person[]>(`persons?search=${encodeURIComponent(term)}`)
        .then((rows) => {
          if (!cancelled) searchResults = rows;
        })
        .catch((e) => {
          if (!cancelled) error = e.message;
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });
  $effect(() => {
    const by = sortBy;
    const session = sessionFilter;
    let cancelled = false;
    if (by === "default") {
      tops = [];
      return;
    }
    const q = new URLSearchParams({ by });
    if (session) q.set("session", session);
    void api<PersonTop[]>(`persons/tops?${q}`)
      .then((rows) => {
        if (!cancelled) tops = rows;
      })
      .catch((e) => {
        if (!cancelled) error = e.message;
      });
    return () => {
      cancelled = true;
    };
  });
  let minuteEvents = $state<Event[]>([]);
  async function selectMinute(at: number) {
    minute = at;
    minuteEvents = [];
    await operation(async () => {
      minuteEvents = await api(
        `events?person=${selectedId}&session=${gridSession}&from=${at}&to=${at + 60000}`,
      );
    });
  }
  async function loadStats(id: string) {
    const q = sessionFilter ? `?session=${sessionFilter}` : "";
    stats = await api<PersonStats>(`persons/${id}/stats${q}`);
  }
  async function select(id: string) {
    selectedId = id;
    error = "";
    stats = null;
    try {
      detail = await api(`persons/${id}`);
      name = detail.display_name;
      selectedIdentities = [];
      target = "";
      grid = [];
      gridLoaded = false;
      minute = null;
      candidates = await api(`persons/${id}/candidates`);
      await loadStats(id);
    } catch (e) {
      error = (e as Error).message;
    }
  }
  async function operation(action: () => Promise<void>) {
    busy = true;
    error = "";
    try {
      await action();
      await onChange();
      merges = await api("merges");
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function merge() {
    const other = people.find((p) => p.id === target);
    if (!other || !detail) return;
    await api("persons/merge", {
      sourceId: detail.id,
      targetId: other.id,
      sourceRevision: detail.revision,
      targetRevision: other.revision,
    });
    await select(other.id);
  }
  async function loadGrid() {
    if (!gridSession || !selectedId) return;
    const s = sessions.find((x) => x.id === gridSession)!;
    const start = Math.floor(s.started_at_ms / 60000) * 60000;
    const end = Math.ceil((s.ended_at_ms ?? Date.now()) / 60000) * 60000;
    if (end - start > 31 * 86400000)
      throw new Error("Выберите сессию короче 31 дня");
    grid = await api(
      `presence?session=${gridSession}&person=${selectedId}&from=${start}&to=${end}`,
    );
    gridLoaded = true;
    minute = null;
  }
  $effect(() => {
    if (initialId) void select(initialId);
  });
  $effect(() => {
    // reload stats when session filter changes while a person is open
    const id = selectedId;
    const session = sessionFilter;
    if (!id) return;
    let cancelled = false;
    const q = session ? `?session=${session}` : "";
    void api<PersonStats>(`persons/${id}/stats${q}`)
      .then((s) => {
        if (!cancelled) stats = s;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  });
  import { onMount } from "svelte";
  onMount(() => {
    void api<any[]>("merges")
      .then((v) => (merges = v))
      .catch((e) => (error = e.message));
  });
  function formatOffset(ms: number | null) {
    if (ms === null) return "—";
    const min = Math.round(ms / 60000);
    return `${min.toLocaleString("ru-RU")} мин`;
  }
</script>

<div class="people-grid">
  <section class="panel">
    <header>
      <h2>Люди</h2>
      <span class="muted small">{people.length}</span>
    </header>
    <div class="tops-tabs" role="tablist" aria-label="Сортировка людей">
      {#each [
        ["default", "Все"],
        ["messages", "Чат"],
        ["donations", "Донаты"],
        ["observed_minutes", "Набл. мин"],
      ] as const as [key, label]}<button
          type="button"
          role="tab"
          class:active={sortBy === key}
          aria-selected={sortBy === key}
          onclick={() => (sortBy = key)}>{label}</button
        >{/each}
    </div>
    {#if sortBy !== "default"}<p class="small muted tops-hint">
        Топ по {sortBy === "messages"
          ? "сообщениям"
          : sortBy === "donations"
            ? "донатам"
            : "наблюдаемым минутам"}{sessionFilter
          ? " за выбранную сессию"
          : " (вся история)"}
      </p>{/if}
    <div class="search">
      <input
        aria-label="Поиск человека"
        placeholder="Найти по имени…"
        bind:value={search}
        disabled={sortBy !== "default"}
      />
    </div>
    <div class="people-list">
    {#if !visible.length}<div class="empty-small">
        <Icon name="people" size={36} />
        <p>Пока никого нет</p>
        <span class="small muted"
          >Аккаунты и донаты появятся после подключения.</span
        >
      </div>{/if}{#each visible as person}<button
        class:chosen={selectedId === person.id}
        class="person-row"
        onclick={() => select(person.id)}
        ><span class="avatar"
          >{person.display_name.slice(0, 1).toUpperCase()}</span
        ><span
          ><strong>{person.display_name}</strong><small>{person.sources}</small
          ></span
        ><span class="count">{person.event_count}</span></button
      >{/each}
    </div>
  </section>
  <section class="panel person-detail">
    {#if !detail}<div class="empty">
        <Icon name="people" size={48} />
        <h3>Выберите человека</h3>
        <p>Активность, донаты и связи аккаунтов.</p>
      </div>{:else}<header>
        <h2>{detail.display_name}</h2>
        <span class="small muted">Группа активности</span>
      </header>
      {#if stats}<div class="kpi-strip" aria-label="Показатели человека">
          <div class="kpi">
            <span>Сообщения</span><strong
              >{stats.messageCount.toLocaleString("ru-RU")}</strong
            >
          </div>
          <div class="kpi">
            <span>Донаты</span><strong
              >{Object.keys(stats.donationTotals).length
                ? Object.entries(stats.donationTotals)
                    .map(([c, a]) => money(a, c))
                    .join(" · ")
                : stats.donationCount
                  ? String(stats.donationCount)
                  : "—"}</strong
            >
          </div>
          <div class="kpi">
            <span>Набл. минуты (сессия)</span><strong
              >{formatDuration(stats.observedMinutesThisSession)}</strong
            >
          </div>
          <div class="kpi">
            <span>Сред. набл. мин / сессия</span><strong
              >{formatDuration(stats.avgObservedMinutes)}</strong
            >
          </div>
          <div class="kpi">
            <span>Первое / последнее событие</span><strong class="kpi-dates"
              >{date(stats.firstEventMs)} → {date(stats.lastEventMs)}</strong
            >
          </div>
          <div class="kpi">
            <span>Первое / последнее наблюдение</span><strong class="kpi-dates"
              >{date(stats.firstObservedMs)} → {date(
                stats.lastObservedMs,
              )}</strong
            >
          </div>
          <div class="kpi">
            <span>Сред. сдвиг до первого наблюдения</span><strong
              >{formatOffset(stats.avgFirstObservedOffsetMs)}</strong
            >
          </div>
        </div>{/if}
      <div class="settings-body">
        <label
          >Имя группы
          <div class="inline">
            <input bind:value={name} /><button
              class="outline"
              disabled={busy}
              onclick={() =>
                operation(async () => {
                  await api(`persons/${detail.id}/rename`, { name });
                  await select(detail.id);
                })}>Сохранить</button
            >
          </div></label
        >
        <h3>Зрители и донатеры</h3>
        <p class="small muted">
          Person — связка. Twitch login = один зритель; одно имя DA = один
          донатер. Одинаковое имя между платформами не доказывает, что это один
          человек, пока нет авто-связи или ручного объединения.
        </p>
        {#each detail.identities as identity}<label class="identity-row"
            ><input
              type="checkbox"
              bind:group={selectedIdentities}
              value={identity.id}
            /><strong>{identity.display_name}</strong><span class="small muted"
              >{identity.source === "twitch"
                ? "Зритель"
                : "Донатер"} · {identity.source} · {identity.external_id}</span
            ></label
          >{/each}
        {#if selectedIdentities.length}<div class="inline">
            <input
              aria-label="Имя новой группы"
              placeholder="Имя новой группы"
              bind:value={splitName}
            /><button
              class="outline"
              disabled={busy || !splitName.trim()}
              onclick={() =>
                operation(async () => {
                  const result = await api("persons/split", {
                    identityIds: selectedIdentities,
                    name: splitName,
                    revision: detail.revision,
                  });
                  await select(result.id);
                })}>Разъединить выбранные</button
            >
          </div>{/if}
        <h3>Объединить с человеком</h3>
        <div class="inline">
          <select aria-label="Целевой человек" bind:value={target}
            ><option value="">Выберите группу…</option
            >{#each people.filter((p) => p.id !== selectedId) as person}<option
                value={person.id}
                >{person.display_name}{candidates.includes(person.id)
                  ? " · совпадает имя"
                  : ""}</option
              >{/each}</select
          ><button
            class="primary"
            disabled={busy || !target}
            onclick={() => operation(merge)}>Объединить</button
          >
        </div>
        {#if target}<p class="small muted">
            Все события и наблюдения этих групп будут связаны. Содержимое
            событий сохранится; отмена доступна ниже.
          </p>{/if}
        <h3>Наблюдения по минутам</h3>
        <div class="inline">
          <select aria-label="Сессия наблюдений" bind:value={gridSession}
            ><option value="">Выберите сессию…</option
            >{#each sessions as session}<option value={session.id}
                >{date(session.started_at_ms)}</option
              >{/each}</select
          ><button
            class="outline"
            disabled={busy || !gridSession}
            onclick={() => operation(loadGrid)}>Показать</button
          >
        </div>
        {#if grid.length}<div class="legend">
            <span><i class="observed"></i>Наблюдался</span><span
              ><i class="not_observed"></i>Не наблюдался</span
            ><span><i class="unknown"></i>Нет данных</span>
          </div>
          <div class="minute-grid">
            {#each grid as cell}<button
                class={cell.state}
                aria-label={`${date(cell.minuteStartMs)}: ${cell.state}`}
                title={`${date(cell.minuteStartMs)}: ${cell.state}`}
                onclick={() => selectMinute(cell.minuteStartMs)}
              ></button>{/each}
          </div>
          <p class="small muted">
            {grid.filter((c) => c.state === "observed").length} минут с наблюдением
            в чате · {grid.filter((c) => c.state !== "unknown")
              .length}/{grid.length} минут с полным опросом
          </p>
          {#if minute !== null}<p class="small">
              Выбрана минута: {date(minute)}. Показаны доступные события этой
              минуты.
            </p>{/if}
        {:else if gridLoaded}
          <p class="empty-small presence-empty">нет данных — эфир не идёт</p>
        {/if}
        <h3>Последние события <span class="small muted">до 200</span></h3>
        <EventList
          events={minute === null ? (detail.events as Event[]) : minuteEvents}
        />
      </div>{/if}
  </section>
</div>
{#if merges.length}<section class="panel audit">
    <header><h2>История объединений</h2></header>
    {#each merges as merge}<div class="capability">
        <span
          >{date(merge.created_at_ms)} · {merge.undone_at_ms
            ? "Отменено"
            : "Объединение"}</span
        ><button
          class="outline small"
          disabled={busy || merge.undone_at_ms !== null}
          onclick={() =>
            operation(async () => {
              await api(`merges/${merge.id}/undo`, {});
              detail = null;
            })}>Отменить</button
        >
      </div>{/each}
  </section>{/if}
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
