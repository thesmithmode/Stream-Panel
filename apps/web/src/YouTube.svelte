<script lang="ts">
  import { onMount } from "svelte";
  import { api, getDataMode } from "./api";
  let data = $state<any>(null), error = $state("");
  async function refresh() {
    if (getDataMode() === "demo") { data = { snapshots: {}, messages: [] }; return; }
    try { data = await api("youtube/data"); error = ""; } catch (e) { error = (e as Error).message; }
  }
  onMount(() => { void refresh(); const timer = setInterval(() => void refresh(), 60000); return () => clearInterval(timer); });
  const channel = $derived(data?.snapshots?.channel?.data);
  const report = $derived(data?.snapshots?.report?.data);
</script>
<section class="panel settings wide">
  <header><h2>YouTube {channel?.snippet?.title ?? ""}</h2></header>
  <div class="settings-body">
    {#if error}<p class="notice error" role="alert">{error}</p>{/if}
    {#if channel}
      <p>Подписчики: {channel.statistics?.hiddenSubscriberCount ? "скрыты" : channel.statistics?.subscriberCount ?? "нет данных"} · Просмотры канала: {channel.statistics?.viewCount ?? "нет данных"}</p>
      {#if report}<p class="muted">Отчёт: {report.start} — {report.end}. Данные YouTube могут поступать с задержкой.</p>
        <div class="table-wrap"><table><thead><tr>{#each report.columnHeaders ?? [] as column}<th>{({day:"Дата",views:"Просмотры",estimatedMinutesWatched:"Минуты просмотра",subscribersGained:"Новые подписчики",subscribersLost:"Отписки"} as Record<string,string>)[column.name] ?? column.name}</th>{/each}</tr></thead>
          <tbody>{#each report.rows ?? [] as row}<tr>{#each row as value}<td>{value}</td>{/each}</tr>{/each}</tbody></table></div>
      {/if}
      <h3>Последние события чата</h3>
      {#each data.messages as message}<p><strong>{message.authorDetails?.displayName ?? "YouTube"}</strong>: {message.snippet?.displayMessage ?? message.snippet?.type}</p>{/each}
      {#if !data.messages.length}<p class="muted">Сообщений пока нет. Сбор работает во время активного эфира.</p>{/if}
    {:else}<p class="muted">Подключите свой канал в разделе «Интеграции». Здесь появятся его отчёты и чат эфиров.</p>{/if}
    <p class="small muted">YouTube не предоставляет список всех зрителей. Чат содержит только события, которые отдал API после подключения.</p>
  </div>
</section>
