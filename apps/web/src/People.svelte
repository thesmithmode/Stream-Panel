<script lang="ts">
  import SectionTabs from "./SectionTabs.svelte";
  import {latestRequest} from './latest-request';
  import {platformClass} from './period';
  import DonorLinks from "./DonorLinks.svelte";
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
  import {tick,untrack} from "svelte";
  import Icon from "./Icon.svelte";
  import {confirmAction} from "./confirmation.svelte";
  import Help from "./Help.svelte";
  import PersonNotes from "./PersonNotes.svelte";
  import RecentEvents from './RecentEvents.svelte';
  import PersonDonations from "./PersonDonations.svelte";
  import Following from "./Following.svelte";
  import PersonMetadata from "./PersonMetadata.svelte";
  let {
    period = "",
    initialId = "",
    onChange,
    onSelect,
  }: {
    period?: string;
    initialId?: string;
    onSelect:(id:string)=>void;
    onChange: () => Promise<void>;
  } = $props();
  let detailTab=$state("overview"),showFollowing=$state(false),detailLoading=$state(false),showDonorLinks=$state(false);
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
  let donorCurrency=$state('RUB'),rankRefresh=$state(0);
  const donorCurrencies=$derived([...new Set(tops.flatMap(p=>Object.keys(p.donationTotals)))].sort());
  const rankLabels=$derived(new Map(tops.map(t=>[t.id,sortBy==='donations'?Object.entries(t.donationTotals).map(([currency,amount])=>money(amount,currency)).join(' · ')||`${t.donationCount} донатов`:sortBy==='observed_minutes'?formatDuration(t.observedMinutes):`${t.messageCount} сообщ.`])));
  let pageRows = $state<Person[]>([]), peopleOffset = $state(0), peopleTotal = $state(0), peopleLoading = $state(false), peopleLoaded=$state(false);
  const directory = latestRequest(), recipients = latestRequest();
  let people = $state<Person[]>([]);
  $effect(()=>{
    const editing=detailTab==='accounts'||detailTab==='donations';void rankRefresh;
    if(!editing)return;
    void recipients.run(signal=>api<Person[]>('persons',undefined,signal),rows=>{people=rows;},failure=>{error=failure.message;});
    return ()=>recipients.cancel();
  });
  const availablePeople = $derived([...new Map([...people,...pageRows].map(person=>[person.id,person])).values()]);
  let selectedSession = '';
  const rows = $derived(
    sortBy === "default"
      ? pageRows
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
  const visible=$derived(sortBy==='default'?rows:rows.filter(person=>person.display_name.toLocaleLowerCase('ru-RU').includes(search.trim().toLocaleLowerCase('ru-RU'))));
  const personTabs=[["overview","Обзор"],["activity","Активность"],["messages","Сообщения"],["donations","Донаты"],["notes","Заметки"],["accounts","Аккаунты"]] as const;
  let directoryScroll=0;
  function clearSelection(){selectedId='';detail=null;stats=null;detailLoading=false;showFollowing=false;}
  async function backToDirectory(){clearSelection();onSelect('');await tick();window.scrollTo({top:directoryScroll});}
  async function openPerson(id:string){directoryScroll=window.scrollY;await select(id);if(matchMedia('(max-width:900px)').matches)window.scrollTo({top:0});}
  function sourcesLabel(sources:string|null){return (sources?.split(',')??[]).map(source=>({twitch:'Twitch',youtube:'YouTube',donationalerts:'DonationAlerts'}[source.trim()]??source.trim())).join(' · ');}
  $effect(()=>{if(detailTab==='accounts'&&detail)untrack(()=>void loadAudit().catch(e=>error=e.message));});
  $effect(()=>{search;period;sortBy;peopleOffset=0;});
  $effect(() => {
    const term=search.trim(), offset=peopleOffset, currentPeriod=period;void rankRefresh;
    if(sortBy!=='default'){peopleLoading=false;return;}
    peopleLoading=true;
    const timer=setTimeout(()=>{
      const query=new URLSearchParams({search:term,period:currentPeriod,offset:String(offset),limit:'50'});
      void directory.run(signal=>api<{items:Person[];total:number}>(`persons/page?${query}`,undefined,signal),result=>{
        pageRows=result.items;peopleTotal=result.total;peopleLoading=false;peopleLoaded=true;
        if(offset>=result.total&&offset>0)peopleOffset=Math.max(0,Math.floor(Math.max(0,result.total-1)/50)*50);
      },failure=>{error=failure.message;peopleLoading=false;});
    },term?200:0);
    return ()=>{clearTimeout(timer);directory.cancel();};
  });
  $effect(() => {
    const by = sortBy,currency=donorCurrency;void rankRefresh;
    const session = period;
    let cancelled = false;
    if (by === "default") {
      tops = [];
      return;
    }
    const q = new URLSearchParams({ by });
    if (session) q.set("period", session);
    if(by==='donations')q.set('currency',currency);
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
    const q = period ? `?period=${period}` : "";
    const value = await api<PersonStats>(`persons/${id}/stats${q}`);
    if (selectedId === id) stats = value;
  }
  async function refreshPerson(id:string,notify=true) {
    const person=await api(`persons/${id}?events=false`);
    if(selectedId===id){detail=person;await loadStats(id);}
    if(notify)await onChange();
  }
  async function select(id: string) {
    if(selectedId!==id)onSelect(id);
    if(selectedId!==id){detailTab="overview";showDonorLinks=false;showFollowing=false;}
    selectedId = id;
    selectedSession = period;
    error = "";
    stats = null;
    detail = null;
    detailLoading = true;
    try {
      const [person, matches,metrics] = await Promise.all([api(`persons/${id}?events=false`),api<string[]>(`persons/${id}/candidates`),api<PersonStats>(`persons/${id}/stats${period ? `?period=${period}` : ""}`)]);
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
      const editingTab=detailTab;
      await action();
      detailTab=editingTab;
      await onChange();
      await loadAudit();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function merge() {
    const other = availablePeople.find((p) => p.id === target);
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
    const id=initialId,session=period;
    untrack(()=>{if(id){if(selectedId!==id||selectedSession!==session)void select(id);}else if(selectedId)clearSelection();});
  });
  import { onMount } from "svelte";
  onMount(() => {
    const update=()=>{rankRefresh++;if(selectedId)void refreshPerson(selectedId,false).catch(e=>error=e.message);};
    window.addEventListener('sp:data-refresh',update);
    return()=>window.removeEventListener('sp:data-refresh',update);
  });
</script>

<div class="people-grid" class:has-selection={!!selectedId}>
  <section class="panel people-directory" aria-label="Список людей">
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
    {#if sortBy==='donations'}<div class="donor-filters">{#if donorCurrencies.length>1}<label>Сортировать по валюте<select aria-label="Валюта сортировки донатеров" bind:value={donorCurrency}>{#each [...new Set(['RUB',...donorCurrencies])] as c}<option value={c}>{c}</option>{/each}</select></label>{/if}</div>{/if}
    <div class="search">
      <input
        aria-label="Поиск человека"
        placeholder="Найти по имени…"
        bind:value={search}
      />
    </div>
    <div class="people-list">
    {#if peopleLoading&&!peopleLoaded&&sortBy==='default'}<p class="small muted" role="status">Загружаем людей…</p>{/if}
    {#if !visible.length&&(peopleLoaded||!peopleLoading)}<div class="empty-small">
        <Icon name="people" size={36} />
        <p>{search.trim()?'Никого не найдено':'Пока никого нет'}</p>
        <span class="small muted"
          >{search.trim()?'Попробуйте другое имя.':'Аккаунты и донаты появятся после подключения.'}</span
        >
      </div>{/if}{#each visible as person}<button
        class:chosen={selectedId === person.id}
        class="person-row"
        aria-label={person.display_name}
        onclick={() => openPerson(person.id)}
        ><span class="avatar sr-only"
          >{person.display_name.slice(0, 1).toUpperCase()}</span
        ><span
          ><strong class={platformClass(person.sources)}>{person.display_name}</strong><small class:sr-only={!person.sources?.includes(',')}>{sourcesLabel(person.sources)}</small
          ></span
        >{#if sortBy!=='default'}<span class="count">{rankLabels.get(person.id)}</span>{/if}</button
      >{/each}
    </div>
    {#if sortBy==='default'&&peopleTotal>50}<div class="people-pages" aria-label="Страницы людей">
      <button class="outline small" disabled={peopleLoading||peopleOffset===0} aria-label="Предыдущие люди" onclick={()=>peopleOffset=Math.max(0,peopleOffset-50)}>Назад</button>
      <span class="small muted">{peopleOffset+1}–{Math.min(peopleOffset+50,peopleTotal)} из {peopleTotal} записей</span>
      <button class="outline small" disabled={peopleLoading||peopleOffset+50>=peopleTotal} aria-label="Следующие люди" onclick={()=>peopleOffset+=50}>Далее</button>
    </div>{/if}
  </section>
  <section class="panel person-detail">
    <button class="text-button people-back" onclick={backToDirectory}><Icon name="back" size={18}/>К списку людей</button>
    {#if detailLoading}<div class="empty" role="status">Загружаем карточку…</div>{:else if !detail}<div class="empty">
        <Icon name="people" size={48} />
        <h3>Выберите человека</h3>
        <p>Активность, донаты и связи аккаунтов.</p>
      </div>{:else}<header>
        <h2 class={platformClass(detail.identities.map((i:any)=>i.source))}>{detail.display_name}</h2>

      </header>

      <div class="person-tab-wrap"><SectionTabs items={personTabs} bind:value={detailTab} label="Разделы человека" panelId="person-tabpanel"/></div>
      <div class="settings-body person-scroll" id="person-tabpanel" role="tabpanel" aria-label={personTabs.find(([key])=>key===detailTab)?.[1]}>
      {#if detailTab==='overview'}
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
            <span>Наблюдаемое время</span><strong
              >{formatDuration(stats.totalObservedMinutes)}</strong
            >
          </div>
          <div class="kpi">
            <span>Среднее за посещённый стрим</span><strong
              >{formatDuration(stats.avgObservedMinutes)}</strong
            >
          </div>
          <div class="kpi">
            <span>Посещаемость</span><strong>{stats.attendanceRatio == null ? "—" : `${Math.round(stats.attendanceRatio * 100)}%`}</strong>

          </div>
          {#if stats.estimatedChatMinutes != null && stats.estimatedChatMinutes > 0}
          <div class="kpi"><span>Оценка активности YouTube</span><strong>{formatDuration(stats.estimatedChatMinutes)}</strong></div>
          {/if}

        </div>{/if}
        <h3>Связанные аккаунты</h3>
        <div class="account-summary">{#each detail.identities as identity}<span><strong class:twitch={identity.source==='twitch'} class:youtube={identity.source==='youtube'}>{identity.display_name}</strong></span>{/each}</div>
        <div class="actions"><button class="outline small" onclick={()=>{detailTab='donations';showDonorLinks=true;}}>Привязать донаты</button></div>
        <details bind:open={showFollowing}><summary>Подписки на канал</summary>{#if showFollowing}<Following personId={detail.id} sessionId="" onPerson={(id)=>void select(id)} />{/if}</details>
      {:else if detailTab==='messages'}
       <RecentEvents personId={detail.id} messagesOnly />
      {:else if detailTab==='accounts'}
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
            /><strong class:twitch={identity.source==='twitch'} class:youtube={identity.source==='youtube'}>{identity.display_name}</strong><span class="small muted"
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
                  if(!await confirmAction("Разъединить аккаунты?","Выбранные аккаунты перейдут в отдельную карточку. История событий сохранится."))return;
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
            >{#each availablePeople.filter((p) => p.id !== selectedId) as person}<option
                value={person.id}
                >{person.display_name}{candidates.includes(person.id)
                  ? " · совпадает имя"
                  : ""}</option
              >{/each}</select
          ><button
            class="primary"
            disabled={busy || !target}
            onclick={() => operation(async()=>{if(await confirmAction("Объединить людей?","Аккаунты и история обеих карточек будут объединены."))await merge();})}>Объединить</button
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
              if(!await confirmAction("Отменить изменение связей?","Связи аккаунтов вернутся к состоянию до этой операции."))return;
              await api(`${merge.kind === "split" ? "splits" : "merges"}/${merge.id}/undo`, {});
              await select(selectedId);
            })}>Отменить</button
        >
      </div>{/each}
  </section>{/if}
      {:else if detailTab==='donations'}
       <button class="outline small" aria-expanded={showDonorLinks} onclick={()=>showDonorLinks=!showDonorLinks}>{showDonorLinks?'Скрыть привязку':'Привязать донаты по нику'}</button>
       {#if showDonorLinks}<DonorLinks personId={detail.id} onChange={()=>refreshPerson(detail.id)} />{/if}
       <PersonDonations personId={detail.id} revision={detail.revision} people={availablePeople} onChange={()=>refreshPerson(detail.id)} />
      {:else if detailTab==='notes'}
       <PersonMetadata personId={detail.id} onChange={()=>refreshPerson(detail.id)} />
       <PersonNotes personId={detail.id} />
      {:else}
       <PersonActivity personId={detail.id} />
       <details bind:open={showFollowing}><summary>Подписки на канал</summary>{#if showFollowing}<Following personId={detail.id} sessionId="" onPerson={(id)=>void select(id)} />{/if}</details>
      {/if}
      </div>{/if}
  </section>
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}

<style>
 .donor-filters{display:flex;gap:12px;flex-wrap:wrap;padding:8px 12px}.donor-filters label{display:grid;gap:6px;font-size:12px}.twitch{color:var(--twitch,#a970ff)!important}.youtube{color:var(--youtube,#ff5959)!important}
 .people-grid{display:grid;grid-template-columns:280px minmax(0,1fr);align-items:stretch;gap:16px;min-height:0;flex:1;}
 .people-grid>section{min-height:0;height:100%;max-height:100%;display:flex;flex-direction:column;overflow:hidden;margin-bottom:0;}
 .people-directory{padding-top:8px;}.people-list{min-height:0;flex:1;max-height:none;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding-bottom:4px}.people-pages{display:grid;grid-template-columns:1fr 1fr;align-items:center;gap:8px;padding:10px 12px;flex:0 0 auto;border-top:1px solid var(--border)}.people-pages span{grid-column:1/-1;grid-row:1;text-align:center;font-size:12px}.people-pages button{min-width:0;min-height:40px}
 .person-scroll{min-height:0;overflow-y:auto;flex:1;padding:14px;}
 .people-back{display:none;}
 .person-detail>.empty{min-height:160px;padding:20px;}
 .person-detail>header{padding:14px;border:0;}
 .person-detail .kpi-strip{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));padding:0;margin-bottom:16px;gap:12px;}
 .person-detail .kpi{background:none;border:0;padding:0;min-height:48px;}
 .person-detail .kpi span{font-size:12px;}.person-detail .kpi strong{font-size:20px;color:#fff;}
 .account-summary{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;}.account-summary>span{display:grid;gap:4px;}
 .person-tab-wrap{padding:0 14px;}
 .person-tab-wrap :global(.section-tabs){display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 12px;margin:0;}
 .person-tab-wrap :global(.section-tabs button){white-space:normal;font-size:12px;line-height:1.3;padding:8px 0;min-height:44px;}
 @media(min-width:901px){:global(main.people-page){display:flex;flex-direction:column;height:100dvh;min-height:0}.people-grid{overflow:hidden;width:100%}}
 @media(min-width:1200px){
  .person-tab-wrap :global(.section-tabs){grid-template-columns:repeat(6,minmax(0,1fr));}
  .person-detail .kpi-strip{grid-template-columns:repeat(3,minmax(0,1fr));}
 }
 @media(max-width:900px){
  .people-grid{display:block;height:auto;min-height:0;}
  .people-grid>section{overflow:visible;height:auto;}
  .people-grid:not(.has-selection)>.person-detail,.people-grid.has-selection>.people-directory{display:none;}
  .people-list{max-height:none;overflow:visible;}
  .people-back{display:flex;align-items:center;gap:6px;min-height:44px;margin:0 12px;}
  .person-detail>header{padding-top:4px;}
  .person-scroll{overflow:visible;}
 }
</style>
