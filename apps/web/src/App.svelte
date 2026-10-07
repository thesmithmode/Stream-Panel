<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "./Icon.svelte";
  import Overview from "./Overview.svelte";
  import Connections from "./Connections.svelte";
  import People from "./People.svelte";
  import {
    api,
    setCsrf,
    date,
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
    busy = $state(false);
  const titles: Record<string, string> = {
    overview: "Обзор эфира",
    sessions: "Сессии",
    people: "Люди",
    connections: "Подключения",
  };
  const descriptions: Record<string, string> = {
    overview: "История чата, донаты и наблюдения.",
    sessions: "История записей и полнота собранных данных.",
    people: "Активность людей и управляемые связи аккаунтов.",
    connections: "Подключите сервисы и проверьте сбор данных.",
  };
  const nav = [
    ["overview", "Обзор"],
    ["sessions", "Сессии"],
    ["people", "Люди"],
    ["connections", "Подключения"],
  ] as const;
  const activeSession = $derived(sessions.find((s) => s.ended_at_ms === null));
  async function refresh() {
    const query = sessionFilter ? `?session=${sessionFilter}` : "";
    const values = await Promise.all([
      api("status"),
      api<Session[]>("sessions"),
      api<Person[]>("persons"),
      api<Event[]>(`events${query}`),
      api<Summary>(`summary${query}`),
    ]);
    status = values[0];
    setCsrf(status.csrf);
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
  onMount(() => {
    let alive = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    async function initialize() {
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
        if (timer) clearInterval(timer);
        timer = setInterval(() => {
          void refresh().catch((e) => (error = e.message));
        }, 5000);
      } catch (e) {
        error = (e as Error).message;
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
      if (timer) clearInterval(timer);
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
        <span>Локальная база</span>
        <span class="small muted sidebar-hint"
          >Вкладку можно закрыть — сбор продолжается. Выход: Ctrl+C или
          STREAM_PANEL_STOP=1</span
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
    {#if loading}<div class="panel empty">
        <p>Открываем локальную базу…</p>
      </div>{:else if !authorized}<section class="panel empty">
        <Icon name="connections" size={48} />
        <h2>Откройте ссылку из терминала</h2>
        <p>
          Запустите Stream Panel и откройте напечатанную ссылку для безопасного
          входа.
        </p>
        <p class="small muted">{error}</p>
      </section>{:else}
      {#if error}<p role="alert" class="notice error">{error}</p>{/if}
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
