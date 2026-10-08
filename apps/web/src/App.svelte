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
    setCsrf,
    date,
    getDataMode,
    setDataMode,
    getProfile,
    setProfile,
    type Profile,
    type DataMode,
    type Session,
    type Person,
    type Summary,
    type Event,
  } from "./api";
  let tab = $state("overview"),
    authorized = $state(false),
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
  let username = $state(""), password = $state(""), user = $state<any>(null);
  let profile = $state<Profile>(getProfile());
  let epoch = 0;
  const authMessage = (code: string) => ({ INVALID_LOGIN: "Неверный логин или пароль", LOGIN_RATE_LIMIT: "Слишком много попыток. Попробуйте позже.", LOGIN_REQUIRED: "Войдите в свой профиль", LOCAL_LOGIN_REQUIRED: "Войдите в свой профиль" }[code] ?? code);
  async function login() {
    busy = true; error = "";
    try {
      const response = await fetch("/api/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
      const result = await response.json();
      password = "";
      if (!response.ok) throw new Error(result.error);
      epoch++; setCsrf(result.csrf); user = result.user;
      if (result.user?.profile) { setProfile(result.user.profile); profile = result.user.profile; }
      await refresh(); authorized = true;
    } catch (e) { error = authMessage((e as Error).message); }
    finally { busy = false; }
  }
  async function logout() {
    try {
      await api("auth/logout", {});
      epoch++; authorized = false; user = null; status = null;
      sessions = []; people = []; events = []; personId = sessionFilter = "";
      summary = { messages: 0, donations: 0, totals: {}, chatters: null, lastPollAtMs: null, events: 0 };
      setCsrf(""); setDataMode("real"); dataMode = "real";
      error = "";
    } catch (e) { error = authMessage((e as Error).message); }
  }
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
    if (dataMode === "real") { setCsrf(status.csrf); user = status.user ?? user; }
    sessions = values[1];
    people = values[2];
    events = values[3];
    summary = values[4];
  }
  async function action(fn: () => Promise<void>) {
    const current = epoch;
    busy = true;
    error = "";
    try {
      await fn();
      await refresh();
    } catch (e) {
      if (current === epoch) error = (e as Error).message;
    } finally {
      if (current === epoch) busy = false;
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
  async function switchProfile(next: Profile) {
    if (next === profile) return;
    epoch++; setProfile(next); profile = next;
    status = null; sessions = []; people = []; events = []; personId = sessionFilter = ""; error = "";
    summary = { messages: 0, donations: 0, totals: {}, chatters: null, lastPollAtMs: null, events: 0 };
    await action(async () => {});
  }
  onMount(() => {
    let alive = true;
    const timer = setInterval(() => {
      if (authorized) void refresh().catch((e) => {
        if (["LOGIN_REQUIRED", "LOCAL_LOGIN_REQUIRED"].includes(e.message)) { epoch++; authorized = false; people = []; events = []; sessions = []; }
        error = authMessage(e.message);
      });
    }, 5000);
    async function initialize() {
      setDataMode("real"); dataMode = "real";
      loading = true;
      error = "";
      try {
        const key = new URLSearchParams(location.hash.slice(1)).get("key");
        if (key) {
          const response = await api("bootstrap", { key });
          setCsrf(response.csrf);
          history.replaceState(null, "", location.pathname);
        }
        await refresh();
        if (!alive) return;
        authorized = true;
      } catch (e) {
        error = authMessage((e as Error).message);
      } finally {
        loading = false;
      }
    }
    void initialize();
    const onHashChange = () => {
      if (new URLSearchParams(location.hash.slice(1)).has("key"))
        void initialize();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      alive = false;
      window.removeEventListener("hashchange", onHashChange);
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
      <span class="dot" class:off={!authorized}></span>
      <div class="sidebar-status">
        {#if authorized}<label class="profile-label">Профиль<select aria-label="Профиль" value={profile} disabled={busy} onchange={(event) => void switchProfile(event.currentTarget.value as Profile)}><option value="ruslan">Руслан</option><option value="gulnaz">Гульназ</option></select></label>{:else}<span>Stream Panel</span>{/if}
        <span class="small muted sidebar-hint"
          >{dataMode === "demo"
            ? "Демонстрационные данные"
            : "Сбор продолжается, когда вкладка закрыта"}</span
        >
      </div>
      <Icon name="arrow" size={17} />
    </div>
  </aside>
  <main>
    <div class="page-heading">
      <div>
        <h1>{titles[tab]}</h1>
        <p>{descriptions[tab]}</p>
      </div>
      <div class="inline" style="justify-content:flex-end">
        {#if authorized && user}<button class="outline" onclick={logout}>Выйти</button>{/if}
        {#if authorized}<div class="mode-toggle" role="group" aria-label="Режим данных">
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
          </div>{/if}
      {#if authorized && tab === "overview"}<button
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
      </div>{:else if !authorized}<section class="panel empty">
        <Icon name="connections" size={48} />
        <h2>Вход в Stream Panel</h2>
        <form class="login-form" onsubmit={(event) => { event.preventDefault(); void login(); }}>
          <label>Логин<input autocomplete="username" bind:value={username} required maxlength="32" /></label>
          <label>Пароль<input type="password" autocomplete="current-password" bind:value={password} required maxlength="256" /></label>
          <button class="primary" disabled={busy}>{busy ? "Входим…" : "Войти"}</button>
        </form>
        {#if error}<p role="alert" class="small notice error">{error}</p>{/if}
      </section>{:else}
      {#if error}<p role="alert" class="notice error">{error}</p>{/if}
      {#if dataMode === "demo"}<p class="demo-banner" role="status">
          Режим <strong>Демо</strong>: показаны фикстуры. Запись в SQLite и
          secrets.json отключена.
        </p>{/if}
      {#key `${profile}:${dataMode}`}
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
        <Analytics profile={user?.profile ?? "local"} mode={dataMode} onPerson={openPerson} />
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
      {/key}
    {/if}
  </main>
</div>
