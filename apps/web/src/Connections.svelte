<script lang="ts">
  import { api } from "./api";
  import { statusLabel } from "./labels";
  import BackupFiles from './BackupFiles.svelte';
  import CollectionGaps from './CollectionGaps.svelte';
  let { status, onChange }: { status: any; onChange: () => Promise<void> } =
    $props();
  let twitchClient = $state(""),
    extended = $state(false),
    youtubeClient = $state(""), youtubeSecret = $state(""),
    daClient = $state(""),
    daSecret = $state(""),
    daToken = $state(""),
    daRefresh = $state(""),
    offset = $state(""),
    busy = $state(false),
    message = $state(""),
    error = $state(""),
    seeded = $state(false);
  // Prefill from saved secrets/config once; keep user edits afterwards.
  $effect(() => {
    const cfg = status?.config;
    if (!cfg || seeded) return;
    if (cfg.youtubeClientId) youtubeClient = cfg.youtubeClientId;
    if (cfg.twitchClientId) twitchClient = cfg.twitchClientId;
    if (cfg.daClientId) daClient = cfg.daClientId;
    if (cfg.daUtcOffsetMinutes != null && cfg.daUtcOffsetMinutes !== "")
      offset = String(cfg.daUtcOffsetMinutes);
    seeded = true;
  });
  const twitchConnected = $derived(status?.twitch?.state === "connected");
  const twitchError = $derived(status?.twitch?.state === "error");
  const daConnected = $derived(status?.donationalerts?.state === "connected");
  const daLive = $derived(
    ["connected", "degraded"].includes(status?.donationalerts?.state),
  );
  async function run(action: () => Promise<void>) {
    busy = true;
    error = "";
    message = "";
    try {
      await action();
      await onChange();
    } catch (e) {
      const code = (e as Error).message;
      error = code === "DA_CLIENT_SECRET_IS_URL"
        ? "В Client Secret вставлен адрес. Скопируйте секрет приложения из кабинета DonationAlerts; Redirect URI указывается отдельно."
        : code;
    } finally {
      busy = false;
    }
  }
  async function twitch() {
    await api("twitch/connect", {
      clientId: twitchClient || status.config.twitchClientId,
      extended,
    });
    message = "Подтвердите вход по ссылке ниже.";
  }
  async function donation() {
    const result = await api("donationalerts/connect", {
      clientId: daClient || status.config.daClientId,
      clientSecret: daSecret,
      accessToken: daToken,
      refreshToken: daRefresh,
      utcOffsetMinutes: (() => {
        const raw = String(offset ?? "").trim();
        if (!raw) return null;
        const n = Number(raw);
        return Number.isInteger(n) ? n : null;
      })(),
    });
    daSecret = daToken = daRefresh = "";
    if (result.url) window.open(result.url, "_blank", "noopener,noreferrer");
    message = result.url
      ? "Завершите вход в открытой вкладке."
      : "Подключение запущено.";
  }
</script>

<div class="settings-grid">
  <section class="panel settings">
    <header>
      <h2>Twitch</h2>
      <span class="state" class:online={twitchConnected}
        >{statusLabel(status.twitch.state)}</span
      >
    </header>
    <div class="settings-body">
      {#if twitchError}<p role="alert" class="notice error">
          Войди снова в Twitch — авторизация сброшена.
        </p>{/if}
      {#if twitchConnected}
        <p class="small">
          {#if status.twitch.account}<strong>{status.twitch.account}</strong
            >{/if}
          <span class="muted">{status.twitch.detail}</span>
        </p>
        <div class="actions">
          <button
            class="outline"
            disabled={busy}
            onclick={() =>
              run(async () => {
                await api("twitch/disconnect", {});
              })}>Отключить</button
          >
        </div>
      {:else}
        <label
          >Client ID<input
            bind:value={twitchClient}
            placeholder={status.config.twitchClientId || "Client ID"}
            autocomplete="off"
          /></label
        >
        <details class="compact-details">
          <summary>Дополнительно</summary>
          <label class="check"
            ><input type="checkbox" bind:checked={extended} /> Подписки, Bits и
            фолловеры</label
          >
          <p class="small muted">
            <a
              href="https://dev.twitch.tv/console/apps"
              target="_blank"
              rel="noreferrer">Twitch Developer Console</a
            > — public client, Device Code.
          </p>
        </details>
        <div class="actions">
          <button class="primary" disabled={busy} onclick={() => run(twitch)}
            >Войти через Twitch</button
          >
        </div>
        {#if status.device}<div class="device">
            <strong>Код: {status.device.userCode}</strong><a
              href={status.device.verificationUri}
              target="_blank"
              rel="noreferrer">Открыть страницу входа</a
            >
            <button
              class="outline small"
              disabled={busy}
              onclick={() =>
                run(async () => {
                  await api("twitch/disconnect", {});
                })}>Отменить</button
            >
          </div>{/if}
        {#if status.twitch.detail}<p class="small muted">
            {status.twitch.detail}
          </p>{/if}
      {/if}
    </div>
  </section>
  <section class="panel settings">
    <header>
      <h2>DonationAlerts</h2>
      <span class="state" class:online={daConnected}
        >{statusLabel(status.donationalerts.state)}</span
      >
    </header>
    <div class="settings-body">
      {#if daLive}
        <p class="small">
          {#if status.donationalerts.account}<strong
              >{status.donationalerts.account}</strong
            >{/if}
          <span class="muted">{status.donationalerts.detail}</span>
        </p>
        <div class="actions">
          <button
            class="outline"
            disabled={busy}
            onclick={() =>
              run(async () => {
                await api("donationalerts/disconnect", {});
              })}>Отключить</button
          >
          <button
            class="text-button"
            disabled={busy}
            onclick={() =>
              run(async () => {
                await api("donationalerts/rescan", {});
                message = "Повторный импорт запущен.";
              })}>Повторить импорт</button
          >
        </div>
        {#if status.config.daUtcOffsetMinutes != null}<p class="small muted">
            UTC offset: {status.config.daUtcOffsetMinutes} мин
          </p>{/if}
      {:else}
        <label
          >Client ID<input
            bind:value={daClient}
            placeholder={status.config.daClientId || "Client ID"}
            autocomplete="off"
          /></label
        >
        {#if ["DA_REAUTH_REQUIRED", "DA_LOGIN_REQUIRED"].includes(status.donationalerts.detail)}
          <p class="small">Доступ DonationAlerts истёк или отозван. Подключите аккаунт снова.</p>
        {/if}
        <label
          >Client secret<input
            type="password"
            bind:value={daSecret}
            placeholder={status.config.hasDaSecret
              ? "Сохранён — можно не вводить"
              : "Client secret"}
            autocomplete="new-password"
          /></label
        >
        {#if status.config.hasDaSecret && !daSecret}<p class="small muted">
            Secret уже сохранён.
          </p>{/if}
        <p class="small muted">
          В настройках приложения DA укажите Redirect URI: <code>{status.config.daRedirectUri}</code>
        </p>
        <p class="small muted">
          Client Secret — секрет из карточки приложения DA, а не адрес Redirect URI.
          <a href="https://www.donationalerts.com/application/clients" target="_blank" rel="noreferrer">Открыть приложения DA</a>
        </p>
        <details class="compact-details">
          <summary>Дополнительно</summary>
          <label
            >UTC offset (минуты)<input
              type="number"
              min="-840"
              max="840"
              bind:value={offset}
              placeholder="пусто = неизвестен"
            /></label
          >
          <label
            >Access token<input
              type="password"
              bind:value={daToken}
              autocomplete="new-password"
            /></label
          >
          <label
            >Refresh token<input
              type="password"
              bind:value={daRefresh}
              autocomplete="new-password"
            /></label
          >
          <p class="small muted">
            <a
              href="https://www.donationalerts.com/application/clients"
              target="_blank"
              rel="noreferrer">Регистрация приложения DA</a
            >
          </p>
        </details>
        <div class="actions">
          <button class="primary" disabled={busy} onclick={() => run(donation)}
            >Подключить DonationAlerts</button
          >
        </div>
        {#if status.donationalerts.detail}<p class="small muted">
            {status.donationalerts.detail}
          </p>{/if}
      {/if}
    </div>
  </section>
  <section class="panel settings">
    <header><h2>YouTube</h2><span class="state" class:online={status.youtube?.state === "connected"}>{statusLabel(status.youtube?.state ?? "disconnected")}</span></header>
    <div class="settings-body">
      <p class="small muted">{status.youtube?.detail ?? "Подключите канал этого профиля"}</p>
      {#if ["connected", "error"].includes(status.youtube?.state)}
        <button class="outline" disabled={busy} onclick={() => run(async () => { await api("youtube/disconnect", {}); })}>Отключить YouTube</button>
      {:else}
        <label>YouTube Client ID<input bind:value={youtubeClient} autocomplete="off" /></label>
        <label>YouTube Client secret<input type="password" bind:value={youtubeSecret} autocomplete="new-password" placeholder={status.config.hasYoutubeSecret ? "Сохранён" : "Client secret"} /></label>
        <p class="small muted">Redirect: <code>{status.config.youtubeRedirectUri ?? ""}</code></p>
        <button class="primary" disabled={busy} onclick={() => run(async () => {
          const result = await api("youtube/connect", {clientId: youtubeClient, clientSecret: youtubeSecret}); youtubeSecret = "";
          window.open(result.url, "_blank", "noopener,noreferrer"); message = "Завершите вход в Google в открытой вкладке.";
        })}>Войти через YouTube</button>
      {/if}
    </div>
  </section>
  <section class="panel settings wide">
    <header><h2>Резервные копии</h2></header>
    <div class="settings-body">
      <button
        class="outline"
        disabled={busy}
        onclick={() =>
          run(async () => {
            const result = await api("backup", {});
            message = result.cloudError ? 'Локальная копия сохранена. Облачная загрузка не удалась.' : `Резервная копия: ${result.filename}`;
          })}>Создать резервную копию</button
      >
      {#if status.backup}<BackupFiles status={status.backup} />{/if}
      <CollectionGaps gaps={status.gaps ?? []} />
    </div>
  </section>
</div>
{#if error}<p role="alert" class="notice error">{error}</p>{/if}{#if message}<p
    role="status"
    class="notice"
  >
    {message}
  </p>{/if}
