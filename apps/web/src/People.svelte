<script lang="ts">
  import {
    api,
    date,
    money,
    type Person,
    type PersonStats,
    type PersonTop,
  } from "./api";
  import { formatDuration } from "./duration";
  import PersonActivity from "./PersonActivity.svelte";
  import {untrack} from "svelte";
  import Icon from "./Icon.svelte";
  import Help from "./Help.svelte";
  import PersonNotes from "./PersonNotes.svelte";
  import PersonDonations from "./PersonDonations.svelte";
  import Following from "./Following.svelte";
  import PersonMetadata from "./PersonMetadata.svelte";
  let {
    people,
    sessionFilter = "",
    initialId = "",
    onChange,
    onSelect,
  }: {
    people: Person[];
    sessionFilter?: string;
    initialId?: string;
    onSelect:(id:string)=>void;
    onChange: () => Promise<void>;
  } = $props();
  let detailTab=$state("activity"),showFollowing=$state(false),detailLoading=$state(false);
  let search = $state(""),
    selectedId = $state(""),
    detail = $state<any>(null),
    stats = $state<PersonStats | null>(null),
    error = $state(""),
    name = $state(""),
    target = $state(""),
    selectedIdentities = $state<string[]>([]),
    splitName = $state(""),
    merges = $state<any[]>([]),
    candidates = $state<string[]>([]),
    busy = $state(false),
    sortBy = $state<"default" | "messages" | "donations" | "observed_minutes">(
      "default",
    ),
    tops = $state<PersonTop[]>([]);
  const rankLabels=$derived(new Map(tops.map(t=>[t.id,sortBy==='donations'?Object.entries(t.donationTotals).map(([currency,amount])=>money(amount,currency)).join(' · ')||`${t.donationCount} донатов`:sortBy==='observed_minutes'?formatDuration(t.observedMinutes):`${t.messageCount} сообщ.`])));
  let searchResults = $state<Person[]>([]);
  let selectedSession = '';
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
  async function loadStats(id: string) {
    const q = sessionFilter ? `?session=${sessionFilter}` : "";
    const value = await api<PersonStats>(`persons/${id}/stats${q}`);
    if (selectedId === id) stats = value;
  }
  async function refreshPerson(id:string) {
    const person=await api(`persons/${id}?events=false`);
    if(selectedId===id){detail=person;await loadStats(id);}
    await onChange();
  }
  async function select(id: string) {
    if(selectedId!==id)onSelect(id);
    selectedId = id;
    selectedSession = sessionFilter;
    error = "";
    stats = null;
    detail = null;
    detailLoading = true;
    try {
      const [person, matches,metrics] = await Promise.all([api(`persons/${id}?events=false`),api<string[]>(`persons/${id}/candidates`),api<PersonStats>(`persons/${id}/stats${sessionFilter ? `?session=${sessionFilter}` : ""}`)]);
      if (selectedId !== id) return;
      detail = person;
      name = detail.display_name;
      selectedIdentities = [];
      target = "";
      candidates = matches;
      stats=metrics;
    } catch (e) {
      if (selectedId === id) error = (e as Error).message;
    } finally {
      if (selectedId === id) detailLoading = false;
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
  $effect(() => {
    const id=initialId,session=sessionFilter;
    if (id) untrack(()=>{if(selectedId!==id||selectedSession!==session)void select(id);});
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

    </header>
    <div class="tops-tabs" role="tablist" aria-label="Сортировка людей">
      {#each [
        ["default", "Все"],
        ["messages", "Чаттеры"],
        ["donations", "Донатеры"],
        ["observed_minutes", "Зрители"],
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
        <p>{search.trim()?'Никого не найдено':'Пока никого нет'}</p>
        <span class="small muted"
          >{search.trim()?'Попробуйте другое имя.':'Аккаунты и донаты появятся после подключения.'}</span
        >
      </div>{/if}{#each visible as person}<button
        class:chosen={selectedId === person.id}
        class="person-row"
        aria-label={person.display_name}
        onclick={() => select(person.id)}
        ><span class="avatar"
          >{person.display_name.slice(0, 1).toUpperCase()}</span
        ><span
          ><strong>{person.display_name}</strong><small>{person.sources}</small
          ></span
        >{#if sortBy!=='default'}<span class="count">{rankLabels.get(person.id)}</span>{/if}</button
      >{/each}
    </div>
  </section>
  <section class="panel person-detail">
    {#if detailLoading}<div class="empty" role="status">Загружаем карточку…</div>{:else if !detail}<div class="empty">
        <Icon name="people" size={48} />
        <h3>Выберите человека</h3>
        <p>Активность, донаты и связи аккаунтов.</p>
      </div>{:else}<header>
        <h2>{detail.display_name}</h2>

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

        </div>{/if}
      <div class="person-tabs" role="tablist" aria-label="Разделы человека">{#each [["activity","Активность"],["donations","Донаты"],["notes","Заметки и метки"],["accounts","Аккаунты" ]] as const as [key,label]}<button role="tab" aria-selected={detailTab===key} class:active={detailTab===key} onclick={()=>detailTab=key}>{label}</button>{/each}</div>
      <div class="settings-body person-scroll">
      {#if detailTab==='accounts'}
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

        <h3>Связанные аккаунты <Help id="person-identities-help" label="О связях аккаунтов" text="Здесь собраны аккаунты одного человека. Совпадающие никнеймы связываются автоматически. При неоднозначном совпадении выберите человека вручную; выбранный аккаунт можно разъединить, сохранив события." /></h3>
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
              await select(selectedId);
            })}>Отменить</button
        >
      </div>{/each}
  </section>{/if}
      {:else if detailTab==='donations'}
       <PersonDonations personId={detail.id} {people} onChange={()=>refreshPerson(detail.id)} />
      {:else if detailTab==='notes'}
       <PersonMetadata personId={detail.id} onChange={()=>refreshPerson(detail.id)} />
       <PersonNotes personId={detail.id} />
      {:else}
       <PersonActivity personId={detail.id} />
       <details bind:open={showFollowing}><summary>Подписки на канал</summary>{#if showFollowing}<Following personId={detail.id} sessionId={sessionFilter} onPerson={(id)=>void select(id)} />{/if}</details>
      {/if}
      </div>{/if}
  </section>
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}

<style>
.people-grid{height:calc(100dvh - 230px);min-height:360px;}.people-grid>section{min-height:0;display:flex;flex-direction:column;overflow:hidden;margin-bottom:0;}.people-list{min-height:0;flex:1;max-height:none;}.person-scroll{min-height:0;overflow-y:auto;flex:1;}.person-tabs{display:flex;gap:.4rem;padding:.6rem 1rem;border-bottom:1px solid var(--border);flex-wrap:wrap;}.person-tabs button{background:transparent;border:0;padding:.5rem .7rem;}.person-tabs button.active{background:#292438;color:var(--accent);}.person-detail .kpi-strip{padding:12px 16px;gap:12px;}.person-detail .kpi span{font-size:11px;}.person-detail .kpi strong{font-size:18px;}@media(max-width:760px){.people-grid{height:auto;min-height:0;}.people-grid>section{overflow:visible;}.people-list{max-height:260px;}.person-scroll{overflow:visible;}}
</style>
