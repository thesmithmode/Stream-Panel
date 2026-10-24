<script lang="ts">
  import {preloadAnalytics,clearAnalyticsCache} from "./analytics-cache";
  import Sheet from "./Sheet.svelte";
  import DonationTotal from "./DonationTotal.svelte";
  import StreamHistory from "./StreamHistory.svelte";
  import PeriodSelect from './PeriodSelect.svelte';
  import { onMount } from "svelte";
  import {readRoute,routeUrl,type View} from "./route";
  import {ConnectionError} from "./request";
  import {isOutdatedRelease} from './release';
  import {viewRequests} from './view-requests';
  import Icon from "./Icon.svelte";
  import Confirmation from "./Confirmation.svelte";
  import {confirmAction} from "./confirmation.svelte";

  import Overview from "./Overview.svelte";
  import ChannelOverview from "./ChannelOverview.svelte";
  import Settings from "./Settings.svelte";
  import StreamDonations from './StreamDonations.svelte';
  import Analytics from "./Analytics.svelte";

  import Connections from "./Connections.svelte";
  let peoplePeriod = $state("");
  import People from "./People.svelte";
  import {
    api,
    setCsrf,
    getProfile,
    setProfile,
    type Profile,
    type Session,
    type Summary,
  } from "./api";


  let retryInitialization=()=>{};
  let autoRefresh=$state(true),refreshSeconds=$state(60);
  function toggleRefresh(){autoRefresh=!autoRefresh;if(autoRefresh)void action(async()=>{});}
  let moreOpen=$state(false);
  let tab = $state("sessions"),
    authorized = $state(false),
    loading = $state(true),
    error = $state(""),
    status = $state<any>(null),
    sessions = $state<Session[]>([]),
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
  let username = $state(""), password = $state(""), user = $state<any>(null);
  let profile = $state<Profile>(getProfile());
  const allowedProfiles = $derived<readonly Profile[]>(user?.allowedProfiles ?? ["ruslan", "gulnaz"]);
  $effect(()=>{
    if(!authorized){clearAnalyticsCache();return;}
    const profiles=[profile,...allowedProfiles.filter(p=>p!==profile)];
    void preloadAnalytics(profiles);
  });
  const accessibleProfile = (next: Profile): Profile => allowedProfiles.includes(next) ? next : allowedProfiles[0]!;
  let sessionPage=$state(0);
  let selectedSessions=$state<string[]>([]);
  let epoch = 0;
  let scopeReady=$state(false),connectionLost=$state(false);
  let outdated=$state(false);
  let refreshTask:{epoch:number;task:Promise<void>;controller:AbortController}|null=null;
  function saveRoute(replace=false){const url=routeUrl({view:tab as View,session:sessionFilter,person:personId,profile});if(replace)history.replaceState(null,'',url);else if(location.pathname+location.search!==url)history.pushState(null,'',url);}
  function clearScope(){selectedSessions=[];sessionPage=0;refreshTask?.controller.abort();busy=false;scopeReady=false;summary={messages:0,donations:0,totals:{},chatters:null,lastPollAtMs:null,events:0};}
  function restoreRoute(){const route=readRoute(location.search,getProfile()),selected=accessibleProfile(route.profile),denied=selected!==route.profile;epoch++;tab=denied&&route.view==='stream'?'sessions':route.view;sessionFilter=denied?'':route.session;personId=denied?'':route.person;setProfile(selected);profile=selected;clearScope();}
  function reportFailure(e:unknown){if(e instanceof ConnectionError){connectionLost=true;return;}connectionLost=!navigator.onLine;if(document.hidden||!navigator.onLine)return;error=authMessage((e as Error).message);}

  const authMessage = (code: string) => ({ INVALID_SESSION_GROUP: "Выберите эфиры в пределах 31 дня (до 100 частей). Активным может быть только последний.", SESSION_GROUP_NOT_FOUND:"Объединение уже отменено. Обновите список.", INVALID_LOGIN: "Неверный логин или пароль", LOGIN_RATE_LIMIT: "Слишком много попыток. Попробуйте позже.", LOGIN_REQUIRED: "Войдите в свой профиль", LOCAL_LOGIN_REQUIRED: "Войдите в свой профиль" }[code] ?? code);
  async function login() {
    busy = true; error = "";
    try {
      const result=await api<any>("auth/login",{username,password});
      password="";
      epoch++; setCsrf(result.csrf); user = result.user;
      if (result.user?.profile) { setProfile(result.user.profile); profile = result.user.profile; }
      await refresh(); authorized = true;saveRoute(true);
    } catch (e) { reportFailure(e); }
    finally { busy = false;retryInitialization(); }
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
    overview: "Итоги канала",
    stream: "Стрим",
    sessions: "Стримы",
    people: "Люди",
    analytics: "Аналитика",
    donations: "Донаты",
    connections: "Интеграции",
    settings: "Настройки",
  };
  let analyticsSection=$state('dynamics'),analyticsBack=$state('sessions');
  const nav = [["sessions","Стримы"],["analytics","Аналитика"],["people","Люди"],["donations","Донаты"]] as const;
  async function refresh(fresh=false,initialStatus?:any) {
    const current=epoch;
    if(refreshTask?.epoch===current){
      if(!fresh)return refreshTask.task;
      // A click or completed mutation needs a read started after that action.
      await refreshTask.task.catch(()=>{});
      if(current!==epoch)return;
    }
    const controller=new AbortController();
    const deadline=setTimeout(()=>controller.abort(new ConnectionError()),12000);
    const task=(async()=>{
      const values=Object.fromEntries(await Promise.all(viewRequests(tab as View,sessionFilter).map(async([key,path])=>[key,key==='status'&&initialStatus?initialStatus:await api(key==='sessions'&&tab==='sessions'&&sessionPage>0?`sessions?offset=${sessionPage*100}`:path,undefined,controller.signal)])));
      if(current!==epoch)return;
      status=values.status;{setCsrf(status.csrf);user=status.user??user;outdated=isOutdatedRelease(status.release);}
      sessions=values.sessions??sessions;selectedSessions=selectedSessions.filter(id=>sessions.some(s=>s.id===id));summary=values.summary??summary;scopeReady=true;connectionLost=!navigator.onLine;error='';window.dispatchEvent(new Event('sp:data-refresh'));
    })();refreshTask={epoch:current,task,controller};
    try{await task;}finally{clearTimeout(deadline);if(refreshTask?.task===task)refreshTask=null;}
  }
  async function action(fn: () => Promise<void>) {
    const current = epoch;
    busy = true;
    error = "";
    try {
      await fn();
      if(current===epoch)await refresh(true);
    } catch (e) {
      if(current===epoch)reportFailure(e);
    } finally {
      if (current === epoch) busy = false;retryInitialization();
    }
  }
  function navigate(next:string,person='') {
    if(next==='analytics'){if(tab!=='analytics')analyticsBack=tab==='stream'?'sessions':tab;analyticsSection='dynamics';}
    moreOpen=false;epoch++;if(next!=='stream')sessionFilter='';tab=next;personId=person;clearScope();saveRoute();
    window.scrollTo({top:0,behavior:'instant'});void action(async()=>{});
  }
  function openPerson(id:string){navigate('people',id);}
  async function mergeSelected(){
    const ids=[...selectedSessions],current=epoch;
    if(!await confirmAction('Объединить стримы?',`Выбрано: ${ids.length}. Статистика будет общей, перерывы сохранятся. Объединение можно отменить.`,'Объединить')||current!==epoch)return;
    await api('sessions/merge',{sessionIds:ids});if(current===epoch)selectedSessions=[];
  }
  async function unmergeSession(id:string){
    const current=epoch;
    if(!await confirmAction('Разъединить стрим?','Каждая исходная часть снова появится отдельно.','Разъединить')||current!==epoch)return;
    await api(`sessions/${id}/unmerge`,{});selectedSessions=[];
  }
  async function switchProfile(next: Profile) {
    if (!allowedProfiles.includes(next) || next === profile) return;
    epoch++;if(tab==="stream")tab="sessions"; setProfile(next); profile = next;
    status = null; sessions = []; personId = sessionFilter = ""; error = "";
    summary = { messages: 0, donations: 0, totals: {}, chatters: null, lastPollAtMs: null, events: 0 };
    clearScope();saveRoute();await action(async () => {});
    if(outdated)location.reload();
  }
  onMount(() => {
    let alive=true,initializing=false,pendingInitialization=false,lastRefresh=Date.now();
    const update=()=>{if(!alive||!autoRefresh||busy||initializing||document.hidden||!navigator.onLine)return;if(!authorized){if(connectionLost&&!username&&!password)void initialize();return;}const current=epoch;void refresh().catch(e=>{if(current!==epoch||!alive)return;if(['LOGIN_REQUIRED','LOCAL_LOGIN_REQUIRED'].includes(e.message)){epoch++;authorized=false;sessions=[];clearScope();}reportFailure(e);});};
    const timer=setInterval(()=>{if(Date.now()-lastRefresh>=refreshSeconds*1000){lastRefresh=Date.now();update();}},1000);
    async function initialize() {
      if(initializing||busy){pendingInitialization=true;return;}pendingInitialization=false;initializing=true;
      restoreRoute();
      loading = true;
      error = "";
      try {
        const key = new URLSearchParams(location.hash.slice(1)).get("key");
        if (key) {
          try{const response=await api("bootstrap",{key});setCsrf(response.csrf);}
          catch(bootstrapError){try{await api("status");}catch{throw bootstrapError;}}
          history.replaceState(null,"",location.pathname+location.search);
        }
        // Establish account permissions before using a persisted or URL-selected profile.
        // Older standalone collectors may lack this route; retain their status flow.
        let initialStatus:any;
        try {const identity=await api<any>("auth/me?status=1");user=identity.user;restoreRoute();if(identity.status?.profile===profile)initialStatus=identity.status;} catch(e) {if((e as Error).message!=="NOT_FOUND"&&(e as Error).message!=="HTTP_404")throw e;}
        const authProfile=profile,auth=initialStatus??await api<any>("status");
        setCsrf(auth.csrf);user=auth.user??user;restoreRoute();
        await refresh(false,profile===authProfile?auth:undefined);
        if (!alive) return;
        authorized=true;saveRoute(true);
      } catch(e){reportFailure(e);
      } finally {
        loading=false;initializing=false;if(pendingInitialization&&alive)void initialize();
      }
    }
    retryInitialization=()=>{if(pendingInitialization&&alive)void initialize();};
    void initialize();
    const onHashChange = () => {
      if (new URLSearchParams(location.hash.slice(1)).has("key"))
        void initialize();
    };
    const back=()=>{if(new URLSearchParams(location.hash.slice(1)).has('key')){void initialize();return;}restoreRoute();void action(async()=>{});};
    const visibility=()=>{if(!document.hidden)update();};
    document.addEventListener("visibilitychange",visibility);
    const offline=()=>connectionLost=true;window.addEventListener('offline',offline);window.addEventListener('popstate',back);window.addEventListener('online',update);window.addEventListener('focus',update);
    window.addEventListener("hashchange", onHashChange);
    return () => {
      alive = false;retryInitialization=()=>{};
      refreshTask?.controller.abort();
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener('offline',offline);window.removeEventListener('popstate',back);window.removeEventListener('online',update);window.removeEventListener('focus',update);document.removeEventListener("visibilitychange",visibility);clearInterval(timer);
    };
  });
</script>
<Confirmation/>


<div class="app-shell">
  <aside class:analytics-context={tab==='analytics'&&scopeReady&&authorized&&!loading} class="sidebar" aria-label="Навигация">
    <a class="brand" href="/">Stream <span>Panel</span></a>
    <nav aria-label="Разделы">
      {#each nav as [key,label]}<button disabled={loading||!authorized} class:active={tab===key||(key==='sessions'&&tab==='stream')} aria-current={tab===key?'page':undefined} onclick={()=>navigate(key)}><Icon name={key}/>{label}</button>{/each}
      <button disabled={loading||!authorized} class:active={moreOpen||['overview','connections','settings'].includes(tab)} aria-expanded={moreOpen} onclick={()=>moreOpen=true}><Icon name="more"/>Ещё</button>
    </nav>
  </aside>
  <main class:sessions-page={tab==='sessions'} class:stream-page={tab==='stream'} class:people-page={tab==='people'}>
    <div class="page-heading">
      {#if tab==='stream'}<button aria-label="К списку стримов" class="back-link text-button" onclick={()=>navigate('sessions')}><Icon name="back"/>Стримы</button>{:else}<h1>{titles[tab]}</h1>{/if}
      {#if authorized}<label class="heading-profile">{#if tab==='analytics'}<button class="icon-button analytics-menu-trigger" aria-label="Ещё" aria-expanded={moreOpen} onclick={()=>moreOpen=true}><Icon name="more"/></button>{/if}<span class="dot" class:off={connectionLost||!autoRefresh} title={connectionLost?'Нет связи':autoRefresh?'Автообновление включено':'Автообновление выключено'}></span><select aria-label="Профиль" value={profile} disabled={busy} onchange={event=>void switchProfile(event.currentTarget.value as Profile)}>{#each allowedProfiles as allowed}<option value={allowed}>{allowed==='ruslan'?'Руслан':'Гульназ'}</option>{/each}</select></label>{/if}
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
      {#if error}<p role="alert" class="small notice error">{error}</p>{/if}
      </section>{:else}
      {#if status?.backup&&(status.backup.cloud?.state!=='success'||status.backup.pendingUploads>0)}<p role="status" class="notice backup-warning">Облачная резервная копия {status?.backup?.cloud?.state==='disabled'?'не настроена':status?.backup?.cloud?.state==='error'?'не загружается':'ожидает подтверждения'}. Проверьте раздел «Настройки».</p>{/if}
      {#if status?.storage?.freeBytes!==null&&status?.storage?.freeBytes<status?.storage?.reserveBytes}<p class="notice" role="status">{status.storage.freeBytes<(status.storage.minFreeBytes??16777216)?'Критически мало места: запись временно остановлена, чтобы не повредить БД. Проверьте «Настройки».':'На сервере мало свободного места. Панель очищает старые копии; сбор данных продолжается. Проверьте «Настройки». '}</p>{/if}
      {#if outdated}<div role="status" class="notice">Доступна новая версия панели для обоих профилей. <button class="outline small" onclick={()=>location.reload()}>Обновить панель</button></div>{/if}
      {#if error}<p role="alert" class="notice error">{error}</p>{/if}
      {#key `${profile}:${tab}:${sessionFilter}`}
      {#if !scopeReady}<div class="panel empty" role="status">Загружаем данные…</div>{:else}
      {#if tab === "people"}<div
            class="session-picker"
          >
            <PeriodSelect label="Период аналитики" value={peoplePeriod?Number(peoplePeriod):'all'} onchange={value=>{peoplePeriod=value==='all'?'':String(value);epoch++;saveRoute();void action(async()=>{});}}/>
          </div>{/if}
      {#if tab === "overview"}<ChannelOverview connect={()=>navigate("connections")} />
      {:else if tab === "stream"}<Overview onStream={id=>{sessionFilter=id;navigate("stream");}} session={sessions.find(s=>s.id===sessionFilter)}
          {summary}
          {sessionFilter}
          connect={() => navigate("connections")}
          onPerson={openPerson}
          changed={()=>refresh(true)}
        />
      {:else if tab === "analytics"}
        <Analytics bind:section={analyticsSection} onBack={()=>navigate(analyticsBack)} profile={profile} defaultTimezone={status.config.analyticsSettings?.timezone??"Europe/Moscow"} onPerson={openPerson} onStream={id=>{sessionFilter=id;navigate("stream");}} />
      {:else if tab === "donations"}<StreamDonations onPerson={openPerson} changed={()=>refresh(true)} />
      {:else if tab === "settings"}<Settings {profile} {status} />
      {:else if tab === "connections"}<Connections
          {status}
          onChange={()=>refresh(true)}
        />
      {:else if tab === "people"}<People
          period={peoplePeriod}
          initialId={personId}
          onSelect={(id)=>{personId=id;saveRoute();}}
          onChange={()=>refresh(true)}
        />
      {:else if tab === "sessions"}
        <DonationTotal open={()=>navigate('donations')}/>
        <StreamHistory {sessions} bind:selected={selectedSessions} {busy} page={sessionPage} onpage={page=>{selectedSessions=[];sessionPage=page;void action(async()=>{});}} onopen={id=>{sessionFilter=id;navigate('stream');}} onmerge={()=>action(mergeSelected)} onunmerge={id=>void action(()=>unmergeSession(id))} ondelete={id=>void action(async()=>{if(!await confirmAction('Удалить стрим?','Стрим исчезнет из истории и аналитики. Сохранённые события останутся.','Удалить'))return;await api(`sessions/${id}/delete`,{});})} validUrl={isConfirmedPlatformUrl}/>
        {#if !sessions.length}<button class="outline" onclick={()=>navigate('connections')}>Открыть интеграции</button>{/if}
      {/if}
      {/if}
      {/key}
    {/if}
  </main>
</div>

<Sheet bind:open={moreOpen} title="Ещё" compact>
 <nav class="more-links" aria-label="Дополнительные разделы">{#each [['connections','Интеграции'],['settings','Настройки'],['overview','Итоги канала']] as const as [key,label]}<button class:active={tab===key} aria-current={tab===key?'page':undefined} onclick={()=>navigate(key)}><Icon name={key}/>{label}<Icon name="arrow" size={18}/></button>{/each}</nav>
 <section class="more-refresh"><h3>Обновление данных</h3><div class="refresh-controls">
 <button class="refresh-toggle" aria-label={`Автообновление ${autoRefresh?'Вкл':'Выкл'}`} aria-pressed={autoRefresh} onclick={toggleRefresh}><span class="dot" class:off={!autoRefresh}></span>Автообновление <strong>{autoRefresh?'Вкл':'Выкл'}</strong></button>
 {#if autoRefresh}<label>Интервал<select aria-label="Интервал автообновления" bind:value={refreshSeconds}><option value={60}>1 мин</option><option value={300}>5 мин</option><option value={900}>15 мин</option></select></label>{/if}
 <button class="outline manual-refresh" disabled={busy} onclick={()=>void action(async()=>{})}><Icon name="refresh" size={18}/><span>{busy?'Обновляем…':'Обновить данные'}</span></button>
 {#if connectionLost}<p role="status">Нет связи с сервером</p>{/if}
 </div></section>
</Sheet>
