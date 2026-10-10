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
  import Help from "./Help.svelte";
  import PersonNotes from "./PersonNotes.svelte";
  import PersonDonations from "./PersonDonations.svelte";
  import PersonMetadata from "./PersonMetadata.svelte";
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
  let createOpen=$state(false),newPersonName=$state("");
  async function createPerson(){await operation(async()=>{const person=await api<{id:string}>("persons",{name:newPersonName});createOpen=false;newPersonName="";await select(person.id);});}
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
    const value = await api<PersonStats>(`persons/${id}/stats${q}`);
    if (selectedId === id) stats = value;
  }
  async function refreshPerson(id:string) {
    const person=await api(`persons/${id}`);
    if(selectedId===id){detail=person;await loadStats(id);}
    await onChange();
  }
  async function select(id: string) {
    selectedId = id;
    error = "";
    stats = null;
    detail = null;
    try {
      const [person, matches] = await Promise.all([api(`persons/${id}`),api<string[]>(`persons/${id}/candidates`)]);
      if (selectedId !== id) return;
      detail = person;
      name = detail.display_name;
      selectedIdentities = [];
      target = "";
      grid = [];
      gridLoaded = false;
      minute = null;
      candidates = matches;
      await loadStats(id);
    } catch (e) {
      if (selectedId === id) error = (e as Error).message;
    }
  }
  async function loadAudit() {
    const [joined,separated]=await Promise.all([api<any[]>("merges"),api<any[]>("splits")]);
    merges=[...joined.map(row=>({...row,kind:"merge"})),...separated.map(row=>({...row,kind:"split"}))].sort((a,b)=>b.created_at_ms-a.created_at_ms);
  }
  async function operation(action: () => Promise<void>) {
    busy = true;
    error = "";
    try {
      await action();
      await onChange();
      await loadAudit();
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
    void loadAudit().catch((e) => (error = e.message));
  });
</script>

<div class="people-grid">
  <section class="panel">
    <header>
      <h2>Люди</h2>
      <button class="outline small" disabled={busy} onclick={()=>createOpen=!createOpen}>Добавить человека</button>
    </header>
    {#if createOpen}<form class="new-person" onsubmit={e=>{e.preventDefault();void createPerson();}}><label>Имя человека<input bind:value={newPersonName} required maxlength="200" disabled={busy}/></label><button class="primary" disabled={busy}>Создать человека</button><button type="button" class="outline" disabled={busy} onclick={()=>createOpen=false}>Отмена</button></form>{/if}
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
            <span>{sessionFilter ? "Время в этом стриме" : "Всего наблюдаемого времени"}</span><strong
              >{formatDuration(sessionFilter ? stats.observedMinutesThisSession : stats.totalObservedMinutes)}</strong
            >
          </div>
          <div class="kpi">
            <span>Среднее за посещённый стрим</span><strong
              >{formatDuration(stats.avgObservedMinutes)}</strong
            >
          </div>
          <div class="kpi">
            <span>Посещаемость</span><strong>{stats.attendanceRatio == null ? "—" : `${Math.round(stats.attendanceRatio * 100)}%`}</strong>
            <small>{stats.sessionsWithAttendance ?? stats.sessionsWithObservation} из {stats.recordedStreams} стримов</small>
          </div>
          {#if stats.estimatedChatMinutes != null && stats.estimatedChatMinutes > 0}
          <div class="kpi"><span>Оценка активности YouTube</span><strong>{formatDuration(stats.estimatedChatMinutes)}</strong></div>
          {/if}
          <div class="kpi">
            <span>Первое наблюдение</span><strong>{date(stats.watchingSinceMs)}</strong>
          </div>
          <div class="kpi">
            <span>Подписан с</span><strong>{date(stats.followedAtMs)}</strong>
          </div>
          <div class="kpi">
            <span>Время до подписки</span><strong>{formatDuration(stats.observedBeforeFollowMinutes)}</strong>
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
        {#key detail.id}
          <PersonMetadata personId={detail.id} onChange={()=>refreshPerson(detail.id)} />
          <PersonDonations personId={detail.id} {people} onChange={()=>detail?refreshPerson(detail.id):Promise.resolve()} />
          <PersonNotes personId={detail.id} />
        {/key}
        <h3>Связанные аккаунты <Help id="person-identities-help" label="О связях аккаунтов" text="Здесь собраны аккаунты одного человека. Совпадение имени служит подсказкой для проверки. YouTube связывается вручную; выбранный аккаунт можно разъединить, сохранив события." /></h3>
        {#each detail.identities as identity}<label class="identity-row"
            ><input
              type="checkbox"
              bind:group={selectedIdentities}
              value={identity.id}
            /><strong>{identity.display_name}</strong><span class="small muted"
              >{identity.source === "donationalerts" ? "Донатер" : "Участник"} · {identity.source === "twitch" ? "Twitch" : identity.source === "youtube" ? "YouTube" : "DonationAlerts"}</span
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
            ><span><i class="unknown"></i>Нет данных</span><span><i class="break"></i>Перерыв</span>
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
            в чате · {grid.filter((c) => ['observed','not_observed'].includes(c.state))
              .length}/{grid.filter(c=>c.state!=='break').length} минут с полным опросом
          </p>
          {#if minute !== null}<p class="small">
              Выбрана минута: {date(minute)}. Показаны доступные события этой
              минуты.
            </p>{/if}
        {:else if gridLoaded}
          <p class="empty-small presence-empty">нет данных — эфир не идёт</p>
        {/if}
        <h3>События</h3>
        <EventList
          events={minute === null ? (detail.events as Event[]) : minuteEvents}
        />
      </div>{/if}
  </section>
</div>
{#if merges.length}<section class="panel audit">
    <header><h2>История связей</h2></header>
    {#each merges as merge}<div class="capability">
        <span
          >{date(merge.created_at_ms)} · {merge.undone_at_ms
            ? "Отменено"
            : merge.kind === "split" ? "Разъединение" : "Объединение"}</span
        ><button
          class="outline small"
          disabled={busy || merge.undone_at_ms !== null}
          onclick={() =>
            operation(async () => {
              await api(`${merge.kind === "split" ? "splits" : "merges"}/${merge.id}/undo`, {});
              detail = null;
            })}>Отменить</button
        >
      </div>{/each}
  </section>{/if}
{#if error}<p class="notice error" role="alert">{error}</p>{/if}

<style>.new-person{display:grid;gap:.7rem;padding:1rem;}.new-person label{display:grid;gap:.4rem;}.new-person input{min-width:0;max-width:100%;box-sizing:border-box;}</style>
