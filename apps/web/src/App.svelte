<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "./Icon.svelte";
  import Overview from "./Overview.svelte";
  import Analytics from "./Analytics.svelte";
  import YouTube from "./YouTube.svelte";
  import Connections from "./Connections.svelte";
  import People from "./People.svelte";
  import {
    api,
    date,
    getDataMode,
    setDataMode,
    type DataMode,
    type Session,
    type Person,
    type Summary,
    type Event,
  } from "./api";
  let tab = $state("overview"),
    loading = $state(true),
    error = $state(""),
    status = $state<any>(null),
    sessions = $state<Session[]>([]),
    people = $state<Person[]>([]),
    events = $state<Event[]>([]),
    summary = $state<Summary>({
      messages: 0,
      donations: 0,
      totals: {},
      chatters: null,
      lastPollAtMs: null,
      events: 0,
    }),
    sessionFilter = $state(""),
    personId = $state(""),
    busy = $state(false),
    dataMode = $state<DataMode>(getDataMode());
  let activeProfile = $state<"ruslan" | "gulnaz">("ruslan");
  let epoch = 0;
  const titles: Record<string, string> = {
    overview: "Обзор эфира",
    sessions: "Сессии",
    people: "Люди",
    analytics: "Аналитика аудитории",
    youtube: "YouTube",
    connections: "Интеграции",
  };
  const descriptions: Record<string, string> = {
    overview: "История чата, донаты и наблюдения.",
    sessions: "История записей и полнота собранных данных.",
    people: "Активность людей и управляемые связи аккаунтов.",
    analytics: "Ядро аудитории, категории и время эфиров. Наблюдения и оценки показаны отдельно.",
    youtube: "Статистика канала и чат эфиров своего профиля.",
    connections: "Twitch, DonationAlerts и YouTube — вход и статус сбора.",
  };
  const nav = [
    ["overview", "Обзор"],
    ["sessions", "Сессии"],
    ["people", "Люди"],
    ["analytics", "Аналитика"],
    ["youtube", "YouTube"],
    ["connections", "Интеграции"],
  ] as const;
  const activeSession = $derived(sessions.find((s) => s.ended_at_ms === null));
  async function refresh() {
    const current = epoch;
    const query = sessionFilter ? `?session=${sessionFilter}` : "";
    const values = await Promise.all([
      api("status"),
      api<Session[]>("sessions"),
      api<Person[]>("persons"),
      api<Event[]>(`events${query}`),
      api<Summary>(`summary${query}`),
    ]);
    if (current !== epoch) return;
    status = values[0];
    sessions = values[1];
    people = values[2];
    events = values[3];
    summary = values[4];
  }
  async function action(fn: () => Promise<void>) {
    busy = true;
    error = "";
    try {
      await fn();
      await refresh();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  function navigate(next: string) {
    tab = next;
    personId = "";
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function openPerson(id: string) {
    navigate("people");
    personId = id;
  }
  async function switchMode(mode: DataMode) {
    if (mode === dataMode) return;
    setDataMode(mode);
    dataMode = mode;
    error = "";
    await action(async () => {});
  }
  async function switchProfile(profile: "ruslan" | "gulnaz") {
    if (profile === activeProfile || busy || loading) return;
    busy = true; error = ""; epoch++;
    try {
      await api("profile", { profile });
      activeProfile = profile;
      sessionFilter = ""; personId = "";
      sessions = []; people = []; events = [];
      summary = { messages:0, donations:0, totals:{}, chatters:null, lastPollAtMs:null, events:0 };
      setDataMode("real"); dataMode = "real";
      await refresh();
    } catch (e) {
      try { await api("profile", { profile: activeProfile }); } catch { /* retain selected profile and surface original error */ }
      error = (e as Error).message;
    }
    finally { busy = false; }
  }
  onMount(() => {
    let alive = true;
    const timer = setInterval(() => {
      void refresh().catch((e) => { error = (e as Error).message; });
    }, 5000);
    async function initialize() {
      setDataMode("real"); dataMode = "real";
      loading = true;
      error = "";
      try {
        const selected = await api<{profile:"ruslan"|"gulnaz"}>("profile");
        activeProfile = selected.profile;
        await refresh();
        if (!alive) return;
      } catch (e) {
        error = (e as Error).message;
      } finally {
        loading = false;
      }
    }
    void initialize();
    return () => {
      alive = false;
      clearInterval(timer);
    };
  });
</script>

<div class="app-shell">
  <aside class="sidebar">
    <a class="brand" href="/">Stream <span>Panel</span></a>
    <nav>
      {#each nav as [key, label]}<button
          class:active={tab === key}
          onclick={() => navigate(key)}><Icon name={key} />{label}</button
        >{/each}
    </nav>
    <div class="sidebar-bottom">
      <label class="profile-switcher">
        <span>Профиль</span>
        <select aria-label="Профиль" value={activeProfile} disabled={busy || loading}
          onchange={(event) => void switchProfile(event.currentTarget.value as "ruslan" | "gulnaz")}>
          <option value="ruslan">Руслан</option>
          <option value="gulnaz">Гульназ</option>
        </select>
        <span class="small muted sidebar-hint">Отдельные история и подключения</span>
      </label>
    </div>
  </aside>
  <main>
    <div class="page-heading">
      <div>
        <h1>{titles[tab]}</h1>
        <p>{descriptions[tab]}</p>
      </div>
      <div class="inline" style="justify-content:flex-end">
        <div class="mode-toggle" role="group" aria-label="Режим данных">
            <button
              type="button"
              class:active={dataMode === "real"}
              disabled={busy}
              onclick={() => switchMode("real")}>Реальные</button
            >
            <button
              type="button"
              class:active={dataMode === "demo"}
              class:demo={true}
              disabled={busy}
              onclick={() => switchMode("demo")}>Демо</button
            >
          </div>
      {#if !loading && tab === "overview"}<button
          class="outline record-button"
          disabled={busy || activeSession?.kind === "platform"}
          onclick={() =>
            action(async () => {
              const open = sessions.find((s) => s.ended_at_ms === null);
              if (open) await api(`sessions/${open.id}/stop`, {});
              else await api("sessions/start", {});
            })}
          ><Icon name="record" />{activeSession?.kind === "platform"
            ? "Эфир идёт"
            : activeSession
              ? "Завершить запись"
              : "Начать запись"}</button
        >{/if}
      </div>
    </div>
    {#if loading}<div class="panel empty">
        <p>Загружаем профиль…</p>
      </div>{:else}
      {#if error}<p role="alert" class="notice error">{error}</p>{/if}
      {#if dataMode === "demo"}<p class="demo-banner" role="status">
          Режим <strong>Демо</strong>: показаны фикстуры. Запись в SQLite и
          secrets.json отключена.
        </p>{/if}
      {#if tab === "overview" || tab === "people"}{#if sessions.length}<div
            class="session-picker"
          >
            <label
              >Период<select
                aria-label="Период аналитики"
                bind:value={sessionFilter}
                onchange={() => action(async () => {})}
                ><option value="">Вся история</option
                >{#each sessions as session}<option value={session.id}
                    >{date(session.started_at_ms)}{session.ended_at_ms === null
                      ? " · запись идёт"
                      : ""}</option
                  >{/each}</select
              ></label
            >{#if tab === "overview"}<span class="small muted"
                >Лента: последние 200 событий</span
              >{:else}<span class="small muted"
                >Фильтр для топов и KPI карточки</span
              >{/if}
          </div>{/if}{/if}
      {#if tab === "overview"}<Overview
          {summary}
          {events}
          {status}
          {sessionFilter}
          connect={() => navigate("connections")}
          onPerson={openPerson}
        />
      {:else if tab === "analytics"}
        <Analytics profile={activeProfile} mode={dataMode} onPerson={openPerson} />
      {:else if tab === "youtube"}
        <YouTube mode={dataMode} />
      {:else if tab === "connections"}<Connections
          {status}
          onChange={refresh}
        />
      {:else if tab === "people"}<People
          {people}
          {sessions}
          {sessionFilter}
          initialId={personId}
          onChange={refresh}
        />
      {:else if tab === "sessions"}<section class="panel">
          <header>
            <h2>История сессий</h2>
            <span class="small muted">Последние 100</span>
          </header>
          {#if !sessions.length}<div class="empty">
              <Icon name="sessions" size={48} />
              <h3>Записей пока нет</h3>
              <p>Сессия появится при начале эфира или ручной записи.</p>
              <button class="primary" onclick={() => navigate("overview")}
                >Перейти к записи</button
              >
            </div>{:else}<div class="table-scroll">
              <table>
                <thead
                  ><tr
                    ><th>Начало</th><th>Конец / состояние</th><th>Источник</th
                    ><th>События</th><th></th></tr
                  ></thead
                ><tbody
                  >{#each sessions as session}<tr
                      ><td>{date(session.started_at_ms)}</td><td
                        >{session.ended_at_ms === null
                          ? "Запись не закрыта"
                          : date(session.ended_at_ms)}<small
                          >{session.end_quality === "estimated"
                            ? "Граница приблизительная"
                            : ""}</small
                        ></td
                      ><td
                        >{session.kind === "manual"
                          ? "Ручная запись"
                          : "Twitch"}</td
                      ><td>{session.event_count}</td><td
                        ><button
                          class="outline small"
                          onclick={() =>
                            action(async () => {
                              sessionFilter = session.id;
                              navigate("overview");
                            })}>Открыть</button
                        ></td
                      ></tr
                    >{/each}</tbody
                >
              </table>
            </div>{/if}
        </section>{/if}
    {/if}
  </main>
</div>
