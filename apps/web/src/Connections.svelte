<script lang="ts">
  import { api } from "./api";
  import { statusLabel } from "./labels";
  import Credentials from './Credentials.svelte';
  import IntegrationGuide from './IntegrationGuide.svelte';
  let { status, onChange }: { status: any; onChange: () => Promise<void> } =
    $props();
  let twitchClient = $state(""),
    extended = $state(true),
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
  <Credentials/>
  <section class="panel settings">
    <header>
      <h2>Twitch</h2>
      <IntegrationGuide provider="Twitch"/>
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
        {#if status.twitch.capabilities.followers}<p class="small muted">{status.twitch.capabilities.followers}</p>{/if}
        <div class="actions">
          {#if status.twitch.capabilities.followers === "Для проверки подписок нужен повторный вход в Twitch с разрешением читать подписчиков"}<button class="primary" disabled={busy} onclick={() => run(twitch)}>Разрешить чтение подписчиков</button>{/if}
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
            ><input type="checkbox" bind:checked={extended} /> Полный сбор событий: подписки, Bits, награды и активность канала</label
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
      <IntegrationGuide provider="DonationAlerts" redirect={status.config.daRedirectUri}/>
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
                await api("donationalerts/rescan?recent=1", {},AbortSignal.timeout(60000));
                message = "Данные о донатах обновлены.";
              })}>Обновить данные о донатах</button
          >
        </div>
        <label>Часовой пояс дат DA<select aria-label="Часовой пояс дат DA" bind:value={offset}><option value="">Не задан</option><option value="0">UTC (GMT)</option><option value="180">Москва (UTC+3)</option>{#if offset&&!['0','180'].includes(offset)}<option value={offset}>UTC {Number(offset)/60>0?'+':''}{Number(offset)/60}</option>{/if}</select></label>
        <button class="outline small" disabled={busy||offset===''} onclick={()=>run(async()=>{const result=await api('donationalerts/timezone',{utcOffsetMinutes:Number(offset)});message=`Время восстановлено: ${result.resolved} донатов.`;})}>Сохранить время DA</button>
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
    <header><h2>YouTube</h2><IntegrationGuide provider="YouTube" redirect={status.config.youtubeRedirectUri??''}/><span class="state" class:online={status.youtube?.state === "connected"}>{statusLabel(status.youtube?.state ?? "disconnected")}</span></header>
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

</div>
{#if error}<p role="alert" class="notice error">{error}</p>{/if}{#if message}<p
    role="status"
    class="notice"
  >
    {message}
  </p>{/if}

<style>
 :global(.settings>header){flex-wrap:wrap;gap:12px;}
</style>
