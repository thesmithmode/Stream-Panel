<script lang="ts">
  import Help from './Help.svelte';
  import {ConnectionError} from "./request";
  import { onMount, untrack } from "svelte";
  import { api } from "./api";
  let data = $state<any>(null), error = $state(""), mounted = $state(false);
  let requestId = 0;
  $effect(() => {if (mounted) untrack(() => void refresh());});
  async function refresh() {
    const id = ++requestId;
    try { const result = await api("youtube/data"); if (id === requestId) { data = result; error = ""; } }
    catch (e) { if (id === requestId && !(e instanceof ConnectionError)) { error = (e as Error).message; data = null; } }
  }
  onMount(() => { mounted = true; const update=()=>void refresh();window.addEventListener('sp:data-refresh',update);return()=>{requestId++;window.removeEventListener('sp:data-refresh',update);}; });
  const channel = $derived(data?.snapshots?.channel?.data);
</script>
<section class="panel settings wide">
  <header><h2>YouTube {channel?.snippet?.title ?? ""}</h2><Help id="youtube-channel-help" label="О данных YouTube" text="YouTube не предоставляет список всех зрителей. Чат содержит только события, которые отдал API после подключения."/></header>
  <div class="settings-body">
    {#if error}<p class="notice error" role="alert">{error}</p>{/if}
    {#if channel}
      <p>Подписчики: {channel.statistics?.hiddenSubscriberCount ? "скрыты" : channel.statistics?.subscriberCount ?? "нет данных"} · Просмотры канала: {channel.statistics?.viewCount ?? "нет данных"}</p>
    {:else}<p class="muted">Подключите свой канал в разделе «Интеграции». Статистика будет доступна в аналитике и отдельных стримах.</p>{/if}
  </div>
</section>
