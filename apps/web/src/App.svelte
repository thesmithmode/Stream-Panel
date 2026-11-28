<script lang="ts">
  import { screenVersion, refreshInterval, type Changes } from './refresh-policy';
  import { setServerVersions, bumpReadRevision, getDataRevision } from './api';
  import { clearAnalyticsCache } from './analytics-cache';
  import DonationTotal from './DonationTotal.svelte';
  import StreamHistory from './StreamHistory.svelte';
  import PeriodSelect from './PeriodSelect.svelte';
  import { onMount, tick } from 'svelte';
  import { initializeNavigation, saveNavigation, canGoBack, rememberScroll, navigationScroll } from './navigation';
  import { readRoute, routeUrl, type HistoryMode, type View } from './route';
  import { moscowDay, type CalendarDay } from '../../../packages/core/src/stream-calendar';
  import { screenData } from './screen-data';
  import { PROFILES } from '../../../packages/core/src/profiles';
  import { ConnectionError } from './request';
  import { isOutdatedRelease } from './release';
  import { viewRequests } from './view-requests';
  import Icon from './Icon.svelte';
  import Confirmation from './Confirmation.svelte';
  import { confirmAction } from './confirmation.svelte';

  import Overview from './Overview.svelte';
  import ChannelOverview from './ChannelOverview.svelte';
  import Settings from './Settings.svelte';
  import StreamDonations from './StreamDonations.svelte';
  import Analytics from './Analytics.svelte';

  import Connections from './Connections.svelte';
  let peoplePeriod = $state('');
  let routeSection = $state(''),
    returnTo = $state('');
  import People from './People.svelte';
  import { api, setCsrf, getProfile, setProfile, type Profile, type Session, type Summary } from './api';

  let retryInitialization = () => {};
  let autoRefresh = $state(true),
    refreshSeconds = $state(60);
  let viewportWidth = $state(0);
  let refreshOpen = $state(false);
  function toggleRefresh() {
    autoRefresh = !autoRefresh;
    if (autoRefresh) void action(async () => {});
  }
  let tab = $state('overview'),
    authorized = $state(false),
    loading = $state(true),
    error = $state(''),
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
    sessionFilter = $state(''),
    personId = $state(''),
    busy = $state(false);
  let username = $state(''),
    password = $state(''),
    user = $state<any>(null);
  let profile = $state<Profile>(getProfile());
  const allowedProfiles = $derived<readonly Profile[]>(user?.allowedProfiles ?? PROFILES);
  $effect(() => {
    if (!authorized) {
      clearAnalyticsCache();
      screens.clear();
    }
  });
  let changes = $state<Changes | null>(null);
  const accessibleProfile = (next: Profile): Profile => (allowedProfiles.includes(next) ? next : allowedProfiles[0]!);
  let sessionPage = $state(0);
  let historyMode = $state<HistoryMode>('tiles');
  let calendarDay = $state(moscowDay(Date.now()));
  let calendarDays = $state<CalendarDay[] | null>(null);
  let historyPending = $state(false);
  let historyError = $state(false);
  const calendarMonth = $derived(calendarDay.slice(0, 7));
  const inCalendar = () => tab === 'sessions' && historyMode === 'calendar';
  let selectedSessions = $state<string[]>([]);
  let epoch = 0;
  let scopeReady = $state(false),
    connectionLost = $state(false),
    scopeMount = $state(0);
  let outdated = $state(false);
  let refreshTask: { epoch: number; task: Promise<void>; controller: AbortController } | null = null;
  // Retain the shell as well as the reports: remounting a cached report must not
  // wait for changes/status first. Revalidate in the background on every visit.
  const screens = new Map<
    string,
    {
      revision: number;
      status: any;
      changes: Changes | null;
      sessions: Session[];
      summary: Summary;
      calendarDays: CalendarDay[] | null;
    }
  >();
  const screenKey = () => JSON.stringify([profile, tab, sessionFilter, sessionPage, inCalendar() ? calendarDay : null]);
  function rememberScreen() {
    const key = screenKey();
    screens.delete(key);
    screens.set(key, { revision: getDataRevision(profile), status, changes, sessions, summary, calendarDays });
    while (screens.size > 24) screens.delete(screens.keys().next().value!);
  }
  function saveRoute(replace = false) {
    const url = routeUrl({
      view: tab as View,
      session: sessionFilter,
      person: personId,
      profile,
      section: routeSection,
      returnTo,
      period: tab === 'people' ? peoplePeriod : undefined,
      ...(tab === 'sessions' ? { historyMode, page: sessionPage } : {}),
      ...(inCalendar() ? { month: calendarMonth, day: calendarDay } : {}),
    });
    saveNavigation(url, replace);
  }
  function clearScope(resetPage = true, keepHistoryMounted = false) {
    const retainedHistory = keepHistoryMounted && scopeReady;
    if (!keepHistoryMounted) scopeMount++;
    historyError = false;
    historyPending = tab === 'sessions';
    if (!keepHistoryMounted) calendarDays = null;
    changes = null;
    selectedSessions = [];
    if (resetPage) sessionPage = 0;
    refreshTask?.controller.abort();
    busy = false;
    scopeReady = false;
    summary = { messages: 0, donations: 0, totals: {}, chatters: null, lastPollAtMs: null, events: 0 };
    const saved = screens.get(screenKey());
    if (saved && saved.revision === getDataRevision(profile)) {
      ({ status, changes, sessions, summary, calendarDays } = saved);
      historyPending = false;
      scopeReady = true;
    } else if (tab === 'sessions') {
      sessions = [];
      scopeReady = retainedHistory || status?.profile === profile;
    } else if (status?.profile === profile && viewRequests(tab as View, sessionFilter).length === 1) {
      // This screen has no shell reads beyond the already authenticated status.
      scopeReady = true;
    }
  }
  function restoreRoute() {
    const route = readRoute(location.search, getProfile()),
      selected = accessibleProfile(route.profile),
      denied = selected !== route.profile;
    epoch++;
    tab = denied && route.view === 'stream' ? 'sessions' : route.view;
    sessionFilter = denied ? '' : route.session;
    personId = denied ? '' : route.person;
    routeSection = route.section ?? '';
    if (route.view === 'analytics')
      analyticsSection = ['dynamics', 'time', 'audience'].includes(routeSection) ? routeSection : 'dynamics';
    returnTo = denied ? '' : (route.returnTo ?? '');
    peoplePeriod = route.period ?? '';
    sessionPage = route.view === 'sessions' && !denied ? (route.page ?? 0) : 0;
    historyMode = denied ? 'tiles' : (route.historyMode ?? 'tiles');
    const today = moscowDay(Date.now());
    calendarDay =
      !denied && route.month ? (route.day ?? (route.month === today.slice(0, 7) ? today : route.month + '-01')) : today;
    setProfile(selected);
    profile = selected;
    clearScope(false);
  }
  function reportFailure(e: unknown) {
    if (e instanceof ConnectionError) {
      connectionLost = true;
      return;
    }
    connectionLost = !navigator.onLine;
    if (document.hidden || !navigator.onLine) return;
    error = authMessage((e as Error).message);
  }

  const authMessage = (code: string) =>
    ({
      INVALID_SESSION_GROUP: 'Выберите эфиры в пределах 31 дня (до 100 частей). Активным может быть только последний.',
      SESSION_ACTIVE: 'Сначала дождитесь завершения эфира.',
      SESSION_GROUP_NOT_FOUND: 'Объединение уже отменено. Обновите список.',
      INVALID_LOGIN: 'Неверный логин или пароль',
      LOGIN_RATE_LIMIT: 'Слишком много попыток. Попробуйте позже.',
      LOGIN_REQUIRED: 'Войдите в свой профиль',
      LOCAL_LOGIN_REQUIRED: 'Войдите в свой профиль',
    })[code] ?? code;
  async function login() {
    busy = true;
    error = '';
    try {
      const result = await api<any>('auth/login', { username, password });
      password = '';
      epoch++;
      setCsrf(result.csrf);
      user = result.user;
      if (result.user?.profile) {
        setProfile(result.user.profile);
        profile = result.user.profile;
      }
      await refresh();
      authorized = true;
      saveRoute(true);
    } catch (e) {
      reportFailure(e);
    } finally {
      busy = false;
      retryInitialization();
    }
  }
  function isConfirmedPlatformUrl(entry: { platform: string; url: string }): boolean {
    try {
      const url = new URL(entry.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
      if (entry.platform === 'youtube')
        return (
          (url.hostname === 'youtube.com' || url.hostname === 'www.youtube.com') &&
          url.pathname === '/watch' &&
          Boolean(url.searchParams.get('v'))
        );
      return (
        entry.platform === 'twitch' &&
        (url.hostname === 'twitch.tv' || url.hostname === 'www.twitch.tv') &&
        /^\/[A-Za-z0-9_]+(?:\/.*)?$/.test(url.pathname)
      );
    } catch {
      return false;
    }
  }
  const titles: Record<string, string> = {
    overview: 'Итоги канала',
    stream: 'Стрим',
    sessions: 'Стримы',
    people: 'Люди',
    analytics: 'Аналитика',
    donations: 'Донаты',
    connections: 'Интеграции',
    settings: 'Настройки',
  };
  let analyticsSection = $state('dynamics');
  const nav = [
    ['overview', 'Обзор'],
    ['sessions', 'Стримы'],
    ['analytics', 'Аналитика'],
    ['people', 'Люди'],
    ['donations', 'Донаты'],
    ['connections', 'Интеграции'],
    ['settings', 'Настройки'],
  ] as const;
  async function refresh(fresh = false, initialStatus?: any) {
    const current = epoch;
    if (refreshTask?.epoch === current) {
      if (!fresh) return refreshTask.task;
      // A click or completed mutation needs a read started after that action.
      await refreshTask.task.catch(() => {});
      if (current !== epoch) return;
    }
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new ConnectionError()), 12000);
    const task = (async () => {
      const next = await api<Changes>(
        `changes?${new URLSearchParams(sessionFilter ? { session: sessionFilter } : {})}`,
        undefined,
        controller.signal,
      );
      if (current !== epoch) return;
      const previous = changes,
        changed =
          !previous ||
          screenVersion(tab as View, sessionFilter, previous) !== screenVersion(tab as View, sessionFilter, next);
      const connectionsChanged = !previous || previous.connectionRevision !== next.connectionRevision;
      const subscribersChanged =
        !previous ||
        previous.versions.subscribers !== next.versions.subscribers ||
        previous.versions.follows !== next.versions.follows;
      setServerVersions(profile, next);
      if (fresh && scopeReady) bumpReadRevision(profile);
      const history = tab === 'sessions';
      const calendar = inCalendar();
      const requests = viewRequests(tab as View, sessionFilter);
      if (calendar) requests.push(['calendar', 'sessions/calendar?month=' + calendarMonth]);
      const historyDomain = 'stream-history:' + screenVersion('sessions', '', next);
      const values = Object.fromEntries(
        await Promise.all(
          requests
            .filter(([key]) =>
              key === 'status'
                ? connectionsChanged || fresh || !scopeReady
                : changed || fresh || !scopeReady || (history && (historyPending || historyError)),
            )
            .map(async ([key, path]) => {
              if (history && (key === 'sessions' || key === 'calendar')) {
                const q = new URLSearchParams();
                if (sessionPage) q.set('offset', String(sessionPage * 100));
                if (calendar) q.set('day', calendarDay);
                const target = key === 'sessions' && q.size ? `sessions?${q}` : path;
                const result = await screenData(target, historyDomain, controller.signal, fresh).catch(() => null);
                return [key, result];
              }
              return [
                key,
                key === 'status' && initialStatus ? initialStatus : await api(path, undefined, controller.signal),
              ];
            }),
        ),
      );
      if (current !== epoch) return;
      if (values.status) {
        status = values.status;
        setCsrf(status.csrf);
        user = status.user ?? user;
      }
      if (status) status = { ...status, sync: next.sync };
      changes = next;
      outdated = isOutdatedRelease(next.release);
      sessions = values.sessions ?? sessions;
      if (calendar && values.calendar) calendarDays = values.calendar;
      if (history && values.sessions !== undefined) {
        historyPending = false;
        historyError = values.sessions === null || (calendar && values.calendar === null);
      }
      selectedSessions = selectedSessions.filter((id) => sessions.some((s) => s.id === id));
      summary = values.summary ?? summary;
      scopeReady = true;
      connectionLost = !navigator.onLine;
      error = '';
      if (!historyError) rememberScreen();
      if (changed || fresh)
        window.dispatchEvent(new CustomEvent('sp:data-refresh', { detail: { validated: true, force: fresh } }));
      if (!previous || previous.versions.activity !== next.versions.activity)
        window.dispatchEvent(new Event('sp:stream-bands-refresh'));
      if (subscribersChanged || fresh) window.dispatchEvent(new Event('sp:subscribers-refresh'));
      window.dispatchEvent(new Event('sp:clock-refresh'));
    })();
    refreshTask = { epoch: current, task, controller };
    try {
      await task;
    } finally {
      clearTimeout(deadline);
      if (refreshTask?.task === task) refreshTask = null;
    }
  }
  async function action(fn: () => Promise<void>, fresh = true) {
    const current = epoch;
    if (fresh) busy = true;
    error = '';
    try {
      await fn();
      if (current === epoch) await refresh(fresh);
    } catch (e) {
      if (current === epoch) {
        if (tab === 'sessions' && historyPending) {
          historyPending = false;
          historyError = true;
        }
        reportFailure(e);
      }
    } finally {
      if (current === epoch && fresh) busy = false;
      retryInitialization();
    }
  }
  function navigate(next: string, person = '', replace = false) {
    if (next === 'analytics') analyticsSection = 'dynamics';
    routeSection = '';
    returnTo = '';
    epoch++;
    if (next !== 'stream') sessionFilter = '';
    if (next === 'sessions') {
      historyMode = 'tiles';
      calendarDay = moscowDay(Date.now());
    }
    tab = next;
    personId = person;
    clearScope();
    saveRoute(replace);
    window.scrollTo({ top: 0, behavior: 'instant' });
    void action(async () => {}, false);
  }
  function loadHistoryScope(keepMonth = false) {
    epoch++;
    if (!keepMonth) calendarDays = null;
    clearScope(false, true);
    saveRoute();
    void action(async () => {}, false);
  }
  function setHistoryMode(mode: HistoryMode) {
    if (mode === historyMode) return;
    const calendarChanged = inCalendar() || mode === 'calendar';
    historyMode = mode;
    if (calendarChanged) {
      sessionPage = 0;
      loadHistoryScope();
    } else saveRoute();
  }
  function setCalendarDay(day: string) {
    if (day === calendarDay) return;
    const keepMonth = day.startsWith(calendarMonth + '-');
    calendarDay = day;
    sessionPage = 0;
    loadHistoryScope(keepMonth);
  }
  function openPerson(id: string) {
    const origin =
      returnTo ||
      routeUrl({
        view: tab as View,
        session: sessionFilter,
        person: personId,
        profile,
        section: routeSection,
        period: tab === 'people' ? peoplePeriod : undefined,
      });
    navigate('people', id);
    returnTo = origin;
    saveRoute(true);
  }
  function goBack() {
    if (canGoBack()) {
      rememberScroll();
      history.back();
      return;
    }
    // A direct link has no in-app predecessor. Return to its natural parent.
    if (tab === 'people' && personId) {
      personId = '';
      routeSection = '';
      returnTo = '';
      saveRoute(true);
      return;
    }
    if (tab === 'people' && returnTo) {
      saveNavigation(returnTo, true);
      restoreRoute();
      void action(async () => {}, false);
      return;
    }
    navigate(tab === 'stream' ? 'sessions' : 'overview', '', true);
  }
  function sectionChanged(section: string) {
    routeSection = section;
    saveRoute();
  }
  async function mergeSelected() {
    const ids = [...selectedSessions],
      current = epoch;
    if (
      !(await confirmAction(
        'Объединить стримы?',
        `Выбрано: ${ids.length}. Статистика будет общей, перерывы сохранятся. Объединение можно отменить.`,
        'Объединить',
      )) ||
      current !== epoch
    )
      return;
    await api('sessions/merge', { sessionIds: ids });
    if (current === epoch) selectedSessions = [];
  }
  async function unmergeSession(id: string) {
    const current = epoch;
    if (
      !(await confirmAction('Разъединить стрим?', 'Каждая исходная часть снова появится отдельно.', 'Разъединить')) ||
      current !== epoch
    )
      return;
    await api(`sessions/${id}/unmerge`, {});
    selectedSessions = [];
  }
  async function switchProfile(next: Profile) {
    if (!allowedProfiles.includes(next) || next === profile) return;
    const current = epoch,
      selectedProfile = profile;
    const stream = tab === 'stream' ? sessions.find((s) => s.id === sessionFilter) : undefined;
    let destination: string | null = null;
    try {
      if (stream) {
        try {
          destination = await api<string | null>(
            `sessions/match-profile?${new URLSearchParams({ session: stream.id, profile: next })}`,
            undefined,
            undefined,
            profile,
          );
        } catch (e) {
          if (!['NOT_FOUND', 'HTTP_404'].includes((e as Error).message)) throw e;
          const latest = await api<string | null>('sessions/match?startedAt=0&latest=1', undefined, undefined, profile);
          destination = await api<string | null>(
            `sessions/match?${new URLSearchParams({ startedAt: String(stream.started_at_ms), latest: latest === stream.id ? '1' : '0' })}`,
            undefined,
            undefined,
            next,
          );
        }
      }
    } catch (e) {
      if (current === epoch) reportFailure(e);
      return;
    }
    if (current !== epoch || profile !== selectedProfile) return;
    routeSection = '';
    returnTo = '';
    epoch++;
    if (tab === 'stream' && !destination) tab = 'sessions';
    setProfile(next);
    profile = next;
    status = null;
    sessions = [];
    personId = sessionFilter = '';
    error = '';
    summary = { messages: 0, donations: 0, totals: {}, chatters: null, lastPollAtMs: null, events: 0 };
    sessionFilter = destination ?? '';
    clearScope();
    saveRoute();
    await action(async () => {}, false);
    if (outdated) location.reload();
  }
  onMount(() => {
    initializeNavigation();
    let alive = true,
      initializing = false,
      pendingInitialization = false,
      lastRefresh = Date.now();
    const update = () => {
      if (!alive || !autoRefresh || busy || initializing || document.hidden || !navigator.onLine) return;
      if (!authorized) {
        if (connectionLost && !username && !password) void initialize();
        return;
      }
      const current = epoch;
      void refresh().catch((e) => {
        if (current !== epoch || !alive) return;
        if (['LOGIN_REQUIRED', 'LOCAL_LOGIN_REQUIRED'].includes(e.message)) {
          epoch++;
          authorized = false;
          sessions = [];
          clearScope();
        }
        reportFailure(e);
      });
    };
    const timer = setInterval(() => {
      if (Date.now() - lastRefresh >= refreshInterval(refreshSeconds, tab as View, sessionFilter, changes) * 1000) {
        lastRefresh = Date.now();
        update();
      }
    }, 1000);
    async function initialize() {
      if (initializing || busy) {
        pendingInitialization = true;
        return;
      }
      pendingInitialization = false;
      initializing = true;
      restoreRoute();
      loading = true;
      error = '';
      try {
        const key = new URLSearchParams(location.hash.slice(1)).get('key');
        if (key) {
          try {
            const response = await api('bootstrap', { key });
            setCsrf(response.csrf);
          } catch (bootstrapError) {
            try {
              await api('status');
            } catch {
              throw bootstrapError;
            }
          }
          history.replaceState(history.state, '', location.pathname + location.search);
        }
        // Establish account permissions before using a persisted or URL-selected profile.
        // Older standalone collectors may lack this route; retain their status flow.
        let initialStatus: any;
        try {
          const identity = await api<any>('auth/me?status=1');
          user = identity.user;
          restoreRoute();
          if (identity.status?.profile === profile) initialStatus = identity.status;
        } catch (e) {
          if ((e as Error).message !== 'NOT_FOUND' && (e as Error).message !== 'HTTP_404') throw e;
        }
        const authProfile = profile,
          auth = initialStatus ?? (await api<any>('status'));
        setCsrf(auth.csrf);
        user = auth.user ?? user;
        restoreRoute();
        await refresh(false, profile === authProfile ? auth : undefined);
        if (!alive) return;
        authorized = true;
        saveRoute(true);
      } catch (e) {
        reportFailure(e);
      } finally {
        loading = false;
        initializing = false;
        if (pendingInitialization && alive) void initialize();
      }
    }
    retryInitialization = () => {
      if (pendingInitialization && alive) void initialize();
    };
    void initialize();
    const onHashChange = () => {
      if (new URLSearchParams(location.hash.slice(1)).has('key')) void initialize();
    };
    const back = () => {
      if (new URLSearchParams(location.hash.slice(1)).has('key')) {
        void initialize();
        return;
      }
      restoreRoute();
      const scroll = navigationScroll(),
        current = epoch;
      void action(async () => {}, false).then(async () => {
        await tick();
        if (current === epoch) window.scrollTo({ top: scroll, behavior: 'instant' });
      });
    };
    const visibility = () => {
      if (!document.hidden) update();
    };
    document.addEventListener('visibilitychange', visibility);
    const offline = () => (connectionLost = true);
    window.addEventListener('offline', offline);
    window.addEventListener('popstate', back);
    window.addEventListener('online', update);
    window.addEventListener('focus', update);
    window.addEventListener('hashchange', onHashChange);
    return () => {
      alive = false;
      retryInitialization = () => {};
      refreshTask?.controller.abort();
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('offline', offline);
      window.removeEventListener('popstate', back);
      window.removeEventListener('online', update);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', visibility);
      clearInterval(timer);
    };
  });
</script>

<svelte:window bind:innerWidth={viewportWidth} />
<Confirmation />

{#snippet refreshControls()}
  <section class="refresh-settings" aria-label="Обновление данных"
    ><div class="refresh-controls">
      <button
        class="refresh-toggle"
        aria-label={`Автообновление ${autoRefresh ? 'Вкл' : 'Выкл'}`}
        aria-pressed={autoRefresh}
        onclick={toggleRefresh}
        ><span class="refresh-label">Автообновление</span><span
          class="toggle-track"
          class:enabled={autoRefresh}
          aria-hidden="true"><span></span></span
        ></button
      >
      {#if autoRefresh}<label
          >Интервал<select aria-label="Интервал автообновления" bind:value={refreshSeconds}
            ><option value={60}>1 мин</option><option value={300}>5 мин</option><option value={900}>15 мин</option
            ></select
          ></label
        >{/if}
      <button class="outline manual-refresh" disabled={busy} onclick={() => void action(async () => {})}
        ><Icon name="refresh" size={18} /><span>{busy ? 'Обновляем…' : 'Обновить данные'}</span></button
      >
      {#if connectionLost}<p role="status">Нет связи с сервером</p>{/if}
    </div></section
  >
{/snippet}

<div
  class="app-shell"
  class:highlight-bots={status?.config?.analyticsSettings?.highlightBots ?? true}
  class:highlight-humans={status?.config?.analyticsSettings?.highlightHumans ?? true}
>
  <aside
    class:analytics-context={tab === 'analytics' && scopeReady && authorized && !loading}
    class="sidebar"
    aria-label="Навигация"
  >
    <a
      class="brand"
      href="/"
      onclick={(event) => {
        if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
          event.preventDefault();
          navigate('overview');
        }
      }}>Stream <span>Panel</span></a
    >
    <nav aria-label="Разделы">
      {#each nav as [key, label]}<button
          disabled={loading || !authorized}
          class:active={tab === key || (key === 'sessions' && tab === 'stream')}
          aria-current={tab === key ? 'page' : undefined}
          onclick={() => navigate(key)}><Icon name={key} />{label}</button
        >{/each}
    </nav>
    {#if authorized}<div class="sidebar-refresh">{@render refreshControls()}</div>{/if}
  </aside>
  <main
    class:analytics-page={tab === 'analytics'}
    class:sessions-page={tab === 'sessions'}
    class:stream-page={tab === 'stream'}
    class:people-page={tab === 'people'}
  >
    <div class="page-heading">
      <div class="heading-location">
        {#if authorized}<button
            class="back-link text-button"
            aria-label="Назад"
            title="Вернуться на предыдущий экран"
            disabled={tab === 'overview' && !canGoBack()}
            onclick={goBack}><Icon name="back" /><span>Назад</span></button
          >{/if}
        {#if tab !== 'stream' && !(tab === 'people' && personId)}<h1>{titles[tab]}</h1>{/if}
      </div>
      {#if authorized}<div class="heading-profile"
          ><span
            class="dot"
            class:off={connectionLost || !autoRefresh}
            title={connectionLost ? 'Нет связи' : autoRefresh ? 'Автообновление включено' : 'Автообновление выключено'}
          ></span><select
            aria-label="Профиль"
            value={profile}
            disabled={busy}
            onchange={(event) => void switchProfile(event.currentTarget.value as Profile)}
            >{#each allowedProfiles as allowed}<option value={allowed}
                >{allowed === 'ruslan' ? 'Руслан' : 'Гульназ'}</option
              >{/each}</select
          ></div
        >{/if}
      {#if authorized}<button
          class="icon-button mobile-refresh-trigger"
          aria-label="Обновление данных"
          title="Обновление данных"
          aria-expanded={refreshOpen}
          onclick={() => (refreshOpen = true)}><Icon name="refresh" /></button
        >{/if}
    </div>
    {#if refreshOpen}<button
        class="mobile-refresh-backdrop"
        aria-label="Закрыть панель обновления"
        onclick={() => (refreshOpen = false)}
      ></button><dialog
        class="mobile-refresh-dialog"
        aria-label="Обновление данных"
        aria-modal="true"
        open
        onkeydown={(event) => {
          if (event.key === 'Escape') refreshOpen = false;
        }}
        ><header
          ><h2>Обновление данных</h2><button
            class="icon-button"
            aria-label="Закрыть"
            onclick={() => (refreshOpen = false)}>×</button
          ></header
        >{@render refreshControls()}</dialog
      >{/if}
    {#if loading}<div class="panel empty">
        <p>Загружаем профиль…</p>
      </div>{:else if !authorized && connectionLost}<section class="panel empty"
        ><p role="status">Нет связи с сервером. Ожидаем подключения…</p><button onclick={() => location.reload()}
          >Попробовать снова</button
        ></section
      >{:else if !authorized}<section class="panel empty">
        <Icon name="connections" size={48} />
        <h2>Вход в Stream Panel</h2>
        <form
          class="login-form"
          onsubmit={(event) => {
            event.preventDefault();
            void login();
          }}
        >
          <label>Логин<input autocomplete="username" bind:value={username} required maxlength="32" /></label>
          <label
            >Пароль<input
              type="password"
              autocomplete="current-password"
              bind:value={password}
              required
              maxlength="256"
            /></label
          >
          <button class="primary" disabled={busy}>{busy ? 'Входим…' : 'Войти'}</button>
        </form>
        {#if error}<p role="alert" class="small notice error">{error}</p>{/if}
      </section>{:else}
      {#if status?.backup && (status.backup.cloud?.state !== 'success' || status.backup.pendingUploads > 0)}<p
          role="status"
          class="notice backup-warning"
          >Облачная резервная копия {status?.backup?.cloud?.state === 'disabled'
            ? 'не настроена'
            : status?.backup?.cloud?.state === 'error'
              ? 'не загружается'
              : 'ожидает подтверждения'}. Проверьте раздел «Настройки».</p
        >{/if}
      {#if status?.storage?.freeBytes !== null && status?.storage?.freeBytes < status?.storage?.reserveBytes}<p
          class="notice"
          role="status"
          >{status.storage.freeBytes < (status.storage.minFreeBytes ?? 16777216)
            ? 'Критически мало места: запись временно остановлена, чтобы не повредить БД. Проверьте «Настройки».'
            : 'На сервере мало свободного места. Панель очищает старые копии; сбор данных продолжается. Проверьте «Настройки». '}</p
        >{/if}
      {#if outdated}<div role="status" class="notice"
          >Доступна новая версия панели для обоих профилей. <button
            class="outline small"
            onclick={() => location.reload()}>Обновить панель</button
          ></div
        >{/if}
      {#if error}<p role="alert" class="notice error">{error}</p>{/if}
      {#key `${profile}:${tab}:${sessionFilter}:${scopeMount}`}
        {#if !scopeReady}<div class="panel empty" role="status">Загружаем данные…</div>{:else}
          {#if tab === 'people'}<div class="session-picker">
              <PeriodSelect
                label="Период аналитики"
                value={peoplePeriod ? Number(peoplePeriod) : 'all'}
                onchange={(value) => {
                  peoplePeriod = value === 'all' ? '' : String(value);
                  epoch++;
                  saveRoute();
                  void action(async () => {});
                }}
              />
            </div>{/if}
          {#if tab === 'overview'}<ChannelOverview
              {profile}
              timezone={status.config.analyticsSettings?.timezone ?? 'Europe/Moscow'}
              connect={() => navigate('connections')}
            />
          {:else if tab === 'stream'}<Overview
              section={routeSection}
              onSection={sectionChanged}
              onStream={(id) => {
                sessionFilter = id;
                navigate('stream');
              }}
              session={sessions.find((s) => s.id === sessionFilter)}
              {summary}
              {sessionFilter}
              connect={() => navigate('connections')}
              onPerson={openPerson}
              changed={() => refresh(true)}
            />
          {:else if tab === 'analytics'}
            <Analytics
              onSection={sectionChanged}
              bind:section={analyticsSection}
              {profile}
              defaultTimezone={status.config.analyticsSettings?.timezone ?? 'Europe/Moscow'}
              onPerson={openPerson}
              onStream={(id) => {
                sessionFilter = id;
                navigate('stream');
              }}
            />
          {:else if tab === 'donations'}<StreamDonations onPerson={openPerson} changed={() => refresh(true)} />
          {:else if tab === 'settings'}<Settings
              {profile}
              {status}
              onChange={() =>
                action(async () => {
                  clearAnalyticsCache();
                })}
            />
          {:else if tab === 'connections'}<Connections {status} onChange={() => refresh(true)} />
          {:else if tab === 'people'}<People
              includeBots={status?.config?.analyticsSettings?.includeBots ?? false}
              period={peoplePeriod}
              initialId={personId}
              section={routeSection}
              onSection={sectionChanged}
              onSelect={(id) => {
                personId = id;
                routeSection = 'overview';
                saveRoute();
              }}
              onChange={() => refresh(true)}
            />
          {:else if tab === 'sessions'}
            <DonationTotal open={() => navigate('donations')} />
            <StreamHistory
              {sessions}
              bind:selected={selectedSessions}
              {busy}
              page={sessionPage}
              mode={historyMode}
              {calendarDay}
              {calendarDays}
              pending={historyPending}
              failed={historyError}
              onmode={setHistoryMode}
              onday={setCalendarDay}
              onretry={() => void action(async () => {})}
              onpage={(page) => {
                sessionPage = page;
                loadHistoryScope(true);
              }}
              onopen={(id) => {
                sessionFilter = id;
                navigate('stream');
              }}
              onmerge={() => action(mergeSelected)}
              onunmerge={(id) => void action(() => unmergeSession(id))}
              ondelete={(id) =>
                void action(async () => {
                  if (
                    !(await confirmAction(
                      'Удалить стрим?',
                      'Стрим исчезнет из истории и аналитики. Сохранённые события останутся.',
                      'Удалить',
                    ))
                  )
                    return;
                  await api(`sessions/${id}/delete`, {});
                })}
              validUrl={isConfirmedPlatformUrl}
            />
            {#if !inCalendar() && !historyPending && !historyError && !sessions.length}<button
                class="outline"
                onclick={() => navigate('connections')}>Открыть интеграции</button
              >{/if}
          {/if}
        {/if}
      {/key}
    {/if}
  </main>
</div>
