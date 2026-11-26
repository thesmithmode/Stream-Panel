<script lang="ts">
  import type { Session } from './api';
  import { money } from './api';
  import { formatDuration } from './duration';
  import { sessionGroup } from './session-group';
  import { compactStreamRange as streamRange } from './stream-time';
  import Help from './Help.svelte';
  import ActionMenu from './ActionMenu.svelte';
  import { routeUrl, type HistoryMode } from './route';
  import type { CalendarDay } from '../../../packages/core/src/stream-calendar';
  import StreamCalendar from './StreamCalendar.svelte';
  import { getProfile } from './api';
  let {
    sessions,
    selected = $bindable([]),
    busy = false,
    page,
    mode,
    calendarDay,
    calendarDays,
    pending,
    failed,
    onmode,
    onday,
    onretry,
    onpage,
    onopen,
    onmerge,
    onunmerge,
    ondelete,
    validUrl,
  }: {
    sessions: Session[];
    selected?: string[];
    busy?: boolean;
    page: number;
    mode: HistoryMode;
    calendarDay: string;
    calendarDays: CalendarDay[] | null;
    pending: boolean;
    failed: boolean;
    onmode: (mode: HistoryMode) => void;
    onday: (day: string) => void;
    onretry: () => void;
    onpage: (page: number) => void;
    onopen: (id: string) => void;
    onmerge: () => Promise<void>;
    onunmerge: (id: string) => void;
    ondelete: (id: string) => void;
    validUrl: (entry: { platform: string; url: string }) => boolean;
  } = $props();
  const modes = [
    ['list', 'Список'],
    ['tiles', 'Плитки'],
    ['calendar', 'Календарь'],
  ] as const;
  const date = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit' });
  const clock = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
  const fullDate = new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long' });
  const metrics = ['Длительность', 'Средние зрители', 'Пик зрителей', 'Донаты', 'Сообщения'];
  let selecting = $state(false);
  function toggle(id: string, checked: boolean) {
    selected = checked ? [...selected, id] : selected.filter((s) => s !== id);
  }
  function selection() {
    selecting = !selecting;
    if (!selecting) selected = [];
  }
</script>

<section class="stream-history" aria-label="История стримов">
  <div class="history-toolbar"
    ><span>История эфиров</span><button class="text-button" aria-pressed={selecting} onclick={selection}
      >{selecting ? 'Отмена' : 'Выбрать'}</button
    ></div
  >
  <div class="history-modes" role="group" aria-label="Вид истории эфиров">
    {#each modes as [value, label] (value)}
      <button type="button" aria-pressed={mode === value} onclick={() => onmode(value)}>{label}</button>
    {/each}
  </div>
  {#if mode === 'calendar'}
    <StreamCalendar day={calendarDay} counts={calendarDays} {onday} />
    <h2 class="history-date">Эфиры за {fullDate.format(Date.parse(calendarDay + 'T00:00:00Z'))}</h2>
  {/if}
  {#if selecting}<div class="selection-toolbar"
      ><span>Выбрано: {selected.length}</span><button
        class="primary"
        disabled={busy || selected.length < 2}
        onclick={async () => {
          await onmerge();
          if (!selected.length) selecting = false;
        }}>Объединить выбранные</button
      ><Help
        id="merge-help"
        label="Об объединении эфиров"
        text="Выберите до 100 частей в пределах 31 дня. Активным может быть только последний эфир. Объединение можно отменить; перерывы сохраняются."
      /></div
    >{/if}
  {#if failed}
    <div class="history-error">
      <span role="alert">Не удалось загрузить историю эфиров.</span>
      <button class="text-button" onclick={onretry} disabled={busy}>Повторить</button>
    </div>
  {/if}
  {#if pending}<p class="empty-small" role="status">Загружаем эфиры…</p>{/if}
  {#if mode === 'list' && sessions.length}
    <div class="history-columns stream-line" aria-hidden="true">
      <span>Начало · МСК</span><span>Стрим</span><span class="wide">Площадки</span>
      {#each metrics as metric, index (metric)}<span class:wide={index > 0}>{metric}</span>{/each}
    </div>
  {/if}
  {#each sessions as session, index (session.id)}
    {@const durationMs = session.durationMs ?? (session.ended_at_ms ?? Date.now()) - session.started_at_ms}
    {@const platforms =
      session.platforms?.map((p) => (p === 'twitch' ? 'Twitch' : 'YouTube')).join(' · ') || 'Источник неизвестен'}
    {@const average =
      (session.viewerKnownMean ?? session.viewerMean)?.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) ?? '—'}
    {@const peak = (session.viewerKnownPeak ?? session.viewerPeak)?.toLocaleString('ru-RU') ?? '—'}
    {@const donations =
      Object.entries(session.donationTotals ?? {})
        .map(([c, a]) => money(a, c))
        .join(' · ') || '—'}
    {#if mode !== 'calendar' && (index === 0 || sessionGroup(session.started_at_ms) !== sessionGroup(sessions[index - 1]!.started_at_ms))}<h2
        class="history-date">{sessionGroup(session.started_at_ms)}</h2
      >{/if}
    <article
      class:stream-card={mode !== 'list'}
      class:history-row={mode === 'list'}
      class:short-stream={session.ended_at_ms !== null && durationMs < 15 * 60_000}
      data-session-id={session.id}
    >
      <a
        class:stream-open={mode !== 'list'}
        class:stream-line={mode === 'list'}
        aria-label={`Открыть ${session.primaryTitle || 'стрим'}${mode === 'list' && session.ended_at_ms === null ? ', в эфире' : ''}`}
        href={routeUrl({ view: 'stream', session: session.id, person: '', profile: getProfile() })}
        onclick={(e) => {
          if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            onopen(session.id);
          }
        }}
      >
        {#if mode === 'list'}
          <time datetime={new Date(session.started_at_ms).toISOString()}
            >{date.format(session.started_at_ms)} {clock.format(session.started_at_ms)}</time
          >
          <span class="stream-line-title" title={session.primaryTitle || 'Без названия'}>
            {#if session.ended_at_ms === null}<span class="live-dot" role="img" aria-label="В эфире"></span>{/if}
            <strong>{session.primaryTitle || 'Без названия'}</strong>
          </span>
          <span class="wide" title={platforms}>{platforms}</span>
          <span class="line-duration" aria-label={'Длительность: ' + formatDuration(durationMs / 60000)}
            >{formatDuration(durationMs / 60000)}</span
          >
          <span class="wide" aria-label={'Средние зрители: ' + average}>{average}</span>
          <span class="wide" aria-label={'Пик зрителей: ' + peak}>{peak}</span>
          <span class="wide" aria-label={'Донаты: ' + donations} title={donations}>{donations}</span>
          <span class="wide" aria-label={'Сообщения: ' + (session.messageCount ?? 0)}>{session.messageCount ?? 0}</span>
        {:else}
          <div class="stream-card-heading">
            <div
              ><span class="stream-period">{streamRange(session.started_at_ms, session.ended_at_ms)}</span><h3
                >{session.primaryTitle || 'Без названия'}</h3
              ><span class="stream-platforms"
                >{platforms}{#if session.ended_at_ms === null}<span class="live-label">В эфире</span
                  >{/if}{#if (session.memberIds?.length ?? 0) > 1}<span>
                    · {session.memberIds!.length} части</span
                  >{/if}</span
              ></div
            >
          </div>
          {#if mode === 'tiles'}
            <dl class="stream-card-metrics">
              {#each [formatDuration(durationMs / 60000), average, peak, donations, session.messageCount ?? 0] as value, i (i)}
                <div><dt>{metrics[i]}</dt><dd>{value}</dd></div>
              {/each}
            </dl>
          {/if}
        {/if}</a
      >
      {#if selecting && session.kind === 'platform'}<label class="stream-selection"
          ><input
            type="checkbox"
            aria-label="Выбрать стрим"
            checked={selected.includes(session.id)}
            disabled={busy}
            onchange={(event) => toggle(session.id, event.currentTarget.checked)}
          />{#if mode !== 'list'}Выбрать{/if}</label
        >{/if}
      <ActionMenu variant="stream-actions" label={`Действия: ${session.primaryTitle || 'стрим'}`} title="Детали эфира"
        >{#snippet children(close)}
          {#if session.viewerPartial}<span class="small muted">Неполные данные площадок: сумма известных зрителей.</span
            >{/if}<span class="small muted">Донатов: {session.donationCount ?? 0}</span>
          {#each (session.confirmedUrls ?? []).filter(validUrl) as entry, index}<a
              href={entry.url}
              target="_blank"
              rel="noopener noreferrer"
              >{entry.platform === 'twitch' ? 'Twitch' : 'YouTube'}{(session.confirmedUrls ?? []).filter(
                (e) => e.platform === entry.platform,
              ).length > 1
                ? ` · часть ${
                    (session.confirmedUrls ?? [])
                      .filter(validUrl)
                      .slice(0, index + 1)
                      .filter((e) => e.platform === entry.platform).length
                  }`
                : ''}</a
            >{/each}
          {#each session.breaks ?? [] as pause}<span class="small">Перерыв: {streamRange(pause.from, pause.to)}</span
            >{/each}
          {#if (session.memberIds?.length ?? 0) > 1}<button
              disabled={busy}
              onclick={() => {
                close();
                onunmerge(session.id);
              }}>Разъединить</button
            >{/if}
          {#if session.kind === 'manual' || session.ended_at_ms !== null}<button
              class="danger"
              disabled={busy}
              onclick={() => {
                close();
                ondelete(session.id);
              }}>Удалить</button
            >{/if}
        {/snippet}</ActionMenu
      >
    </article>
  {:else}
    {#if !pending && !failed}<div class="empty-small"
        >{mode === 'calendar' ? 'В этот день стримов не было' : 'Стримов пока нет'}</div
      >{/if}
  {/each}
  {#if !pending && !failed && (page > 0 || sessions.length >= 100)}<div class="history-pages"
      ><button class="outline" disabled={busy || page === 0} onclick={() => onpage(page - 1)}>Предыдущие</button><span
        >Страница {page + 1}</span
      ><button class="outline" disabled={busy || sessions.length < 100} onclick={() => onpage(page + 1)}
        >Следующие</button
      ></div
    >{/if}
</section>

<style>
  .history-modes {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 4px;
    border: 1px solid var(--border);
    border-radius: 9px;
    padding: 3px;
    margin-bottom: 12px;
    max-width: 420px;
  }
  .history-modes button {
    min-height: 44px;
    padding: 0 4px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--muted);
    font-size: 14px;
  }
  .history-modes button[aria-pressed='true'] {
    background: color-mix(in srgb, var(--accent) 19%, var(--surface));
    color: var(--text);
  }
  .history-error {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .history-row {
    display: flex;
    align-items: center;
    min-width: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 3px;
  }
  .history-row.short-stream {
    background: color-mix(in srgb, #f55c65 15%, var(--surface));
  }
  .stream-line {
    display: grid;
    grid-template-columns: 76px minmax(0, 1fr) fit-content(74px);
    gap: 6px;
    align-items: center;
    flex: 1;
    min-width: 0;
    min-height: 44px;
    padding-left: 8px;
    text-decoration: none;
    color: inherit;
    font-size: 13px;
    white-space: nowrap;
  }
  .stream-line > *,
  .stream-line-title strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .stream-line:focus-visible {
    outline-offset: -2px;
  }
  .stream-line-title {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  time,
  .history-columns {
    color: var(--muted);
  }
  .history-row .stream-selection {
    margin: 0;
    min-width: 24px;
    min-height: 44px;
    justify-content: center;
  }
  .live-dot {
    flex: 0 0 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--teal);
  }
  .line-duration {
    text-align: right;
  }
  .history-columns,
  .wide {
    display: none;
  }
  @media (min-width: 1050px) {
    .stream-line {
      grid-template-columns: 90px minmax(0, 2.5fr) minmax(0, 1.3fr) repeat(5, minmax(0, 1fr));
      gap: 10px;
    }
    .wide {
      display: block;
    }
    .history-columns {
      display: grid;
      margin-right: 45px;
      min-height: 32px;
    }
    .line-duration {
      text-align: left;
    }
  }
</style>
