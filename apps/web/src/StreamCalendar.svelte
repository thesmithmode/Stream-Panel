<script lang="ts">
  import { calendarDayMs, shiftCalendarMonth, type CalendarDay } from '../../../packages/core/src/stream-calendar';
  let { day, counts, onday }: { day: string; counts: CalendarDay[] | null; onday: (day: string) => void } = $props();
  const month = $derived(day.slice(0, 7));
  const first = $derived(Date.parse(month + '-01T00:00:00Z'));
  const previous = $derived(shiftCalendarMonth(month, -1));
  const next = $derived(shiftCalendarMonth(month, 1));
  const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const monthFormat = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const dayFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
  const tally = $derived(new Map(counts?.map(({ day, count }) => [day, count])));
  const cells = $derived.by(() => {
    const lead = (new Date(first).getUTCDay() + 6) % 7;
    const days = new Date(first);
    days.setUTCMonth(days.getUTCMonth() + 1, 0);
    const length = days.getUTCDate();
    return Array.from({ length: Math.ceil((lead + length) / 7) * 7 }, (_, i) => {
      const offset = i - lead;
      return offset < 0 || offset >= length
        ? null
        : new Date(first + offset * calendarDayMs).toISOString().slice(0, 10);
    });
  });
</script>

<div class="calendar" aria-label="Календарь стримов, МСК">
  <div class="calendar-month">
    <button
      type="button"
      aria-label="Предыдущий месяц"
      disabled={!previous}
      onclick={() => previous && onday(previous + '-01')}>‹</button
    >
    <h2>{monthFormat.format(first)}</h2>
    <button type="button" aria-label="Следующий месяц" disabled={!next} onclick={() => next && onday(next + '-01')}
      >›</button
    >
  </div>
  <div class="calendar-grid">
    {#each weekdays as weekday (weekday)}<span class="weekday" aria-hidden="true">{weekday}</span>{/each}
    {#each cells as date, index (index)}
      {#if date}
        {@const count = tally.get(date) ?? 0}
        <button
          type="button"
          aria-label={dayFormat.format(Date.parse(date + 'T00:00:00Z')) +
            (counts ? (count ? `, эфиров: ${count}` : ', без эфиров') : '')}
          aria-pressed={day === date}
          onclick={() => onday(date)}
        >
          {Number(date.slice(-2))}
          {#if count === 1}<span class="dot" aria-hidden="true"></span>{:else if count > 1}<span
              class="count"
              aria-hidden="true">{count}</span
            >{/if}
        </button>
      {:else}<span></span>{/if}
    {/each}
  </div>
</div>

<style>
  .calendar {
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    padding: 8px;
    margin-bottom: 12px;
  }
  .calendar-month {
    display: grid;
    grid-template-columns: 44px 1fr 44px;
    align-items: center;
    text-align: center;
  }
  h2 {
    font-size: 16px;
  }
  h2::first-letter {
    text-transform: uppercase;
  }
  button {
    min-height: 44px;
    border: 0;
    border-radius: 8px;
    background: transparent;
  }
  .calendar-month button {
    color: var(--accent);
    font-size: 25px;
  }
  .calendar-grid {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    text-align: center;
  }
  .weekday {
    padding: 8px 0;
    color: var(--muted);
    font-size: 13px;
  }
  .calendar-grid button {
    display: grid;
    grid-template-rows: 17px 12px;
    align-content: center;
    justify-items: center;
    gap: 1px;
    font-size: 14px;
  }
  button:hover:not(:disabled),
  button[aria-pressed='true'] {
    background: color-mix(in srgb, var(--accent) 19%, var(--surface));
  }
  .dot {
    align-self: center;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
  }
  .count {
    color: var(--accent);
    font-size: 11px;
    line-height: 1;
  }
</style>
