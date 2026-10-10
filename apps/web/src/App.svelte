<script lang="ts">
  import { onMount } from "svelte";
  import {readRoute,routeUrl,type View} from "./route";
  import {ConnectionError} from "./request";
  import Icon from "./Icon.svelte";
  import {streamRange} from "./stream-time";
  import Overview from "./Overview.svelte";
  import ChannelOverview from "./ChannelOverview.svelte";
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
  let scopeReady=$state(false),connectionLost=$state(false);
  let refreshTask:{epoch:number;task:Promise<void>}|null=null;
  function saveRoute(replace=false){const url=routeUrl({view:tab as View,session:sessionFilter,person:personId,profile,mode:dataMode});if(replace)history.replaceState(null,'',url);else if(location.pathname+location.search!==url)history.pushState(null,'',url);}
  function clearScope(){busy=false;scopeReady=false;events=[];summary={messages:0,donations:0,totals:{},chatters:null,lastPollAtMs:null,events:0};}
  function restoreRoute(){const route=readRoute(location.search,getProfile());epoch++;tab=route.view;sessionFilter=route.session;personId=route.person;setProfile(route.profile);profile=route.profile;setDataMode(route.mode);dataMode=route.mode;clearScope();}
  function reportFailure(e:unknown){if(e instanceof ConnectionError){connectionLost=true;return;}error=authMessage((e as Error).message);}

  const authMessage = (code: string) => ({ INVALID_LOGIN: "Неверный логин или пароль", LOGIN_RATE_LIMIT: "Слишком много попыток. Попробуйте позже.", LOGIN_REQUIRED: "Войдите в свой профиль", LOCAL_LOGIN_REQUIRED: "Войдите в свой профиль" }[code] ?? code);
  async function login() {
    busy = true; error = "";
    try {
      const result=await api<any>("auth/login",{username,password});
      password="";
      epoch++; setCsrf(result.csrf); user = result.user;
      if (result.user?.profile) { setProfile(result.user.profile); profile = result.user.profile; }
      setDataMode(dataMode);await refresh(); authorized = true;saveRoute(true);
    } catch (e) { reportFailure(e); }
    finally { busy = false; }
  }
  async function logout() {
    try {
      await api("auth/logout", {});
      epoch++; authorized = false; user = null; status = null;
      sessions = []; people = []; events = []; personId = sessionFilter = "";
      summary = { messages: 0, donations: 0, totals: {}, chatters: null, lastPollAtMs: null, events: 0 };
      setCsrf(""); setDataMode("real"); dataMode = "real";
      tab="overview";clearScope();saveRoute(true);error = "";
    } catch (e) { reportFailure(e); }
  }
  function isConfirmedPlatformUrl(entry: { platform: string; url: string }): boolean {
    try {
      const url = new URL(entry.url);
      if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
      if (entry.platform === "youtube")
        return (url.hostname === "youtube.com" || url.hostname === "www.youtube.com") && url.pathname === "/watch" && Boolean(url.searchParams.get("v"));
      return entry.platform === "twitch" && (url.hostname === "twitch.tv" || url.hostname === "www.twitch.tv") && /^\/[A-Za-z0-9_]+(?:\/.*)?$/.test(url.pathname);
    } catch { return false; }
  }
  const titles: Record<string, string> = {
    overview: "Обзор канала",
    stream: "Стрим",
    sessions: "Стримы",
    people: "Люди",
    analytics: "Аналитика аудитории",
    connections: "Интеграции",
  };
  const descriptions: Record<string, string> = {
    overview: "История чата, донаты и наблюдения.",
    sessions: "История стримов и полнота собранных данных.",
    people: "Активность людей и управляемые связи аккаунтов.",
    analytics: "Ядро аудитории, категории и время эфиров. Наблюдения и оценки показаны отдельно.",
    connections: "Twitch, DonationAlerts и YouTube — вход и статус сбора.",
  };
  const nav = [
    ["overview", "Обзор"],
    ["sessions", "Стримы"],
    ["people", "Люди"],
    ["analytics", "Аналитика"],
    ["connections", "Интеграции"],
  ] as const;
  async function refresh() {
    const current=epoch;if(refreshTask?.epoch===current)return refreshTask.task;
    const query=(tab==='stream'||tab==='people')&&sessionFilter?`?session=${encodeURIComponent(sessionFilter)}`:'';
    const task=(async()=>{
      const values=await Promise.all([api('status'),api<Session[]>('sessions'),api<Person[]>('persons'),api<Event[]>(`events${query}`),api<Summary>(`summary${query}`)]);
      if(current!==epoch)return;
      status=values[0];if(dataMode==='real'){setCsrf(status.csrf);user=status.user??user;}
      sessions=values[1];people=values[2];events=values[3];summary=values[4];scopeReady=true;connectionLost=false;error='';
    })();refreshTask={epoch:current,task};
    try{await task;}finally{if(refreshTask?.task===task)refreshTask=null;}
  }
  async function action(fn: () => Promise<void>) {
    const current = epoch;
    busy = true;
    error = "";
    try {
      await fn();
      await refresh();
    } catch (e) {
      if(current===epoch)reportFailure(e);
    } finally {
      if (current === epoch) busy = false;
    }
  }
  function navigate(next:string,person='') {
    epoch++;if(next==='overview')sessionFilter='';tab=next;personId=person;clearScope();saveRoute();
    window.scrollTo({top:0,behavior:'instant'});void action(async()=>{});
  }
  function openPerson(id:string){navigate('people',id);}
  async function switchMode(mode: DataMode) {
    if (mode === dataMode) return;
    epoch++;sessionFilter="";personId="";if(tab==="stream")tab="overview";
    setDataMode(mode);
    dataMode=mode;clearScope();saveRoute();
    error="";
    await action(async () => {});
  }
  async function switchProfile(next: Profile) {
    if (next === profile) return;
    epoch++;if(tab==="stream")tab="overview"; setProfile(next); profile = next;
    status = null; sessions = []; people = []; events = []; personId = sessionFilter = ""; error = "";
    summary = { messages: 0, donations: 0, totals: {}, chatters: null, lastPollAtMs: null, events: 0 };
    clearScope();saveRoute();await action(async () => {});
  }
  onMount(() => {
    let alive=true,initializing=false;
    const update=()=>{if(!alive||document.hidden||!navigator.onLine)return;if(!authorized){void initialize();return;}const current=epoch;void refresh().catch(e=>{if(current!==epoch||!alive)return;if(['LOGIN_REQUIRED','LOCAL_LOGIN_REQUIRED'].includes(e.message)){epoch++;authorized=false;people=[];events=[];sessions=[];clearScope();}reportFailure(e);});};
    const timer=setInterval(update,5000);
    async function initialize() {
      if(initializing)return;initializing=true;
      restoreRoute();setDataMode("real");
      loading = true;
      error = "";
      try {
        const key = new URLSearchParams(location.hash.slice(1)).get("key");
        if (key) {
          const response = await api("bootstrap", { key });
          setCsrf(response.csrf);
          history.replaceState(null,"",location.pathname+location.search);
        }
        const auth=await api<any>("status");
        setCsrf(auth.csrf);user=auth.user;restoreRoute();
        await refresh();
        if (!alive) return;
        authorized=true;saveRoute(true);
      } catch(e){reportFailure(e);
      } finally {
        loading=false;initializing=false;
      }
    }
    void initialize();
    const onHashChange = () => {
      if (new URLSearchParams(location.hash.slice(1)).has("key"))
        void initialize();
    };
    const back=()=>{restoreRoute();update();};
    const offline=()=>connectionLost=true;window.addEventListener('offline',offline);window.addEventListener('popstate',back);window.addEventListener('online',update);window.addEventListener('focus',update);document.addEventListener('visibilitychange',update);
    window.addEventListener("hashchange", onHashChange);
    return () => {
      alive = false;
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener('offline',offline);window.removeEventListener('popstate',back);window.removeEventListener('online',update);window.removeEventListener('focus',update);document.removeEventListener('visibilitychange',update);clearInterval(timer);
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
      </div>
    </div>
    {#if loading}<div class="panel empty">
        <p>Загружаем профиль…</p>
      </div>{:else if !authorized&&connectionLost}<section class="panel empty"><p role="status">Нет связи с сервером. Ожидаем подключения…</p><button onclick={()=>location.reload()}>Попробовать снова</button></section>{:else if !authorized}<section class="panel empty">
        <Icon name="connections" size={48} />
        <h2>Вход в Stream Panel</h2>
        <form class="login-form" onsubmit={(event) => { event.preventDefault(); void login(); }}>
          <label>Логин<input autocomplete="username" bind:value={username} required maxlength="32" /></label>
          <label>Пароль<input type="password" autocomplete="current-password" bind:value={password} required maxlength="256" /></label>
          <button class="primary" disabled={busy}>{busy ? "Входим…" : "Войти"}</button>
        </form>
        {#if connectionLost}<p role="status" class="notice">Связь прервана. Показываем последние загруженные данные.</p>{/if}
      {#if error}<p role="alert" class="small notice error">{error}</p>{/if}
      </section>{:else}
      {#if error}<p role="alert" class="notice error">{error}</p>{/if}
      {#if dataMode === "demo"}<p class="demo-banner" role="status">
          Режим <strong>Демо</strong>: показаны фикстуры. Запись в SQLite и
          secrets.json отключена.
        </p>{/if}
      {#key `${profile}:${dataMode}:${tab}:${sessionFilter}:${personId}`}
      {#if !scopeReady}<div class="panel empty" role="status">Загружаем данные…</div>{:else}
      {#if tab === "people"}{#if sessions.length}<div
            class="session-picker"
          >
            <label
              >Период<select
                aria-label="Период аналитики"
                bind:value={sessionFilter}
                onchange={()=>{epoch++;clearScope();saveRoute();void action(async()=>{});}}
                ><option value="">Вся история</option
                >{#each sessions as session}<option value={session.id}
                    >{date(session.started_at_ms)}{session.ended_at_ms === null
                      ? " · запись идёт"
                      : ""}</option
                  >{/each}</select
              ></label
            >
          </div>{/if}{/if}
      {#if tab === "overview"}<ChannelOverview {events} onPerson={openPerson} onStream={id=>{sessionFilter=id;navigate("stream");}} connect={()=>navigate("connections")} />
      {:else if tab === "stream"}<button class="outline" onclick={()=>navigate("sessions")}>К списку стримов</button><Overview session={sessions.find(s=>s.id===sessionFilter)}
          {summary}
          {events}
          {sessionFilter}
          connect={() => navigate("connections")}
          onPerson={openPerson}
        />
      {:else if tab === "analytics"}
        <Analytics profile={user?.profile ?? "local"} mode={dataMode} onPerson={openPerson} />
      {:else if tab === "connections"}<Connections
          {status}
          onChange={refresh}
        />
        <YouTube mode={dataMode} />
      {:else if tab === "people"}<People
          {people}
          {sessions}
          {sessionFilter}
          initialId={personId}
          onSelect={(id)=>{personId=id;saveRoute();}}
          onChange={refresh}
        />
      {:else if tab === "sessions"}<section class="panel">
          <header>
            <h2>История стримов</h2>
            <span class="small muted">Последние 100</span>
          </header>
          {#if !sessions.length}<div class="empty">
              <Icon name="sessions" size={48} />
              <h3>Стримов пока нет</h3>
              <p>Стрим появится автоматически при начале эфира.</p>
            </div>{:else}<div class="table-scroll">
              <table>
                <thead
                  ><tr
                    ><th>Период · МСК</th><th>Площадки</th
                    ><th>Название и ссылка</th><th>События</th><th></th></tr
                  ></thead
                ><tbody
                  >{#each sessions as session}<tr data-session-id={session.id}
                      > <td>{streamRange(session.started_at_ms,session.ended_at_ms)}
                        {#each session.breaks??[] as pause}<small>Перерыв: {streamRange(pause.from,pause.to)}</small>{/each}
                        {#if session.end_quality==='estimated'}<small>Граница приблизительная</small>{/if}
                        </td
                      ><td class="platform-labels"
                        >{session.platforms?.length
                          ? session.platforms.map((platform) => platform === "twitch" ? "Twitch" : "YouTube").join(", ")
                          : "Источник неизвестен"}</td
                      ><td class="platform-details">
                        {#if session.primaryTitle}<span>{session.primaryTitle}</span>{/if}
                        {#each (session.confirmedUrls ?? []).filter((entry) => isConfirmedPlatformUrl(entry)) as entry}
                          <a href={entry.url} target="_blank" rel="noopener noreferrer">{entry.platform === "twitch" ? "Twitch" : "YouTube"}</a>
                        {/each}
                      </td
                      ><td>{session.event_count}</td><td
                        ><button
                          class="outline small"
                          onclick={() =>
                            action(async () => {
                              sessionFilter = session.id;
                              navigate("stream");
                            })}>Открыть</button
                          >{#if session.kind === "manual"}<button class="outline small" onclick={()=>action(async()=>{await api(`sessions/${session.id}/delete`,{});if(sessionFilter===session.id)sessionFilter="";await refresh();})}>Удалить</button>{/if}
                        </td
                      ></tr
                    >{/each}</tbody
                >
              </table>
            </div>{/if}
        </section>{/if}
      {/if}
      {/key}
    {/if}
  </main>
</div>
