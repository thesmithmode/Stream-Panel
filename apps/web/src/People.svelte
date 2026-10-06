<script lang="ts">
  import { api, date, type Person, type Session, type Event } from "./api";
  import EventList from "./EventList.svelte";
  import Icon from "./Icon.svelte";
  let {
    people,
    sessions,
    initialId = "",
    onChange,
  }: {
    people: Person[];
    sessions: Session[];
    initialId?: string;
    onChange: () => Promise<void>;
  } = $props();
  let search = $state(""),
    selectedId = $state(""),
    detail = $state<any>(null),
    error = $state(""),
    name = $state(""),
    target = $state(""),
    selectedIdentities = $state<string[]>([]),
    splitName = $state(""),
    gridSession = $state(""),
    grid = $state<{ minuteStartMs: number; state: string }[]>([]),
    merges = $state<any[]>([]),
    candidates = $state<string[]>([]),
    busy = $state(false),
    minute = $state<number | null>(null);
  let searchResults = $state<Person[]>([]);
  const visible = $derived(search.trim() ? searchResults : people);
  $effect(() => {
    const term = search.trim();
    let cancelled = false;
    if (!term) {
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
  async function select(id: string) {
    selectedId = id;
    error = "";
    try {
      detail = await api(`persons/${id}`);
      name = detail.display_name;
      selectedIdentities = [];
      target = "";
      grid = [];
      minute = null;
      candidates = await api(`persons/${id}/candidates`);
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
    minute = null;
  }
  $effect(() => {
    if (initialId) void select(initialId);
  });
  import { onMount } from "svelte";
  onMount(() => {
    void api<any[]>("merges")
      .then((v) => (merges = v))
      .catch((e) => (error = e.message));
  });
</script>

<div class="people-grid">
  <section class="panel">
    <header>
      <h2>Люди</h2>
      <span class="muted small">{people.length}</span>
    </header>
    <div class="search">
      <input
        aria-label="Поиск человека"
        placeholder="Найти по имени…"
        bind:value={search}
      />
    </div>
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
        <h3>Аккаунты и донатные события</h3>
        <p class="small muted">
          Одинаковое имя не доказывает, что это один человек.
        </p>
        {#each detail.identities as identity}<label class="identity-row"
            ><input
              type="checkbox"
              bind:group={selectedIdentities}
              value={identity.id}
            /><strong>{identity.display_name}</strong><span class="small muted"
              >{identity.source} · {identity.external_id}</span
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
            </p>{/if}{/if}
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
