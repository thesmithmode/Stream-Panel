<script lang="ts">
  import { api } from "./api";
  let { status, onChange }: { status: any; onChange: () => Promise<void> } =
    $props();
  let twitchClient = $state(""),
    extended = $state(false),
    daClient = $state(""),
    daSecret = $state(""),
    daToken = $state(""),
    daRefresh = $state(""),
    offset = $state(""),
    busy = $state(false),
    message = $state(""),
    error = $state("");
  async function run(action: () => Promise<void>) {
    busy = true;
    error = "";
    message = "";
    try {
      await action();
      await onChange();
    } catch (e) {
      error = (e as Error).message;
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
      utcOffsetMinutes: offset === "" ? null : Number(offset),
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
      <span class="state" class:online={status.twitch.state === "connected"}
        >{status.twitch.state}</span
      >
    </header>
    <div class="settings-body">
      <p class="muted">
        Вход владельца канала. Приложение читает чат и события.
      </p>
      {#if status.twitch.state === "error"}<p role="alert" class="notice error">
          Войди снова в Twitch — авторизация сброшена (HTTP 400/401).
        </p>{/if}
      <label
        >Client ID своего public OAuth-приложения<input
          bind:value={twitchClient}
          placeholder={status.config.twitchClientId || "Client ID"}
          autocomplete="off"
        /></label
      >
      <p class="small muted">
        Создайте приложение в <a
          href="https://dev.twitch.tv/console/apps"
          target="_blank"
          rel="noreferrer">Twitch Developer Console</a
        >, выбрав public client для Device Code flow.
      </p>
      <label class="check"
        ><input type="checkbox" bind:checked={extended} /> Также подписки, Bits и
        фолловеры</label
      >
      <div class="actions">
        <button class="primary" disabled={busy} onclick={() => run(twitch)}
          >Войти через Twitch</button
        ><button
          class="outline"
          disabled={busy}
          onclick={() =>
            run(async () => {
              await api("twitch/disconnect", {});
            })}>Отключить</button
        >
      </div>
      {#if status.device}<div class="device">
          <strong>Код: {status.device.userCode}</strong><a
            href={status.device.verificationUri}
            target="_blank"
            rel="noreferrer">Открыть страницу входа</a
          >
        </div>{/if}
      <p class="small muted">
        {status.twitch.account || ""}
        {status.twitch.detail}
      </p>
      {#each Object.entries(status.twitch.capabilities || {}) as [key, value]}<div
          class="capability"
        >
          <span>{key}</span><span>{String(value)}</span>
        </div>{/each}
    </div>
  </section>
  <section class="panel settings">
    <header>
      <h2>DonationAlerts</h2>
      <span
        class="state"
        class:online={status.donationalerts.state === "connected"}
        >{status.donationalerts.state}</span
      >
    </header>
    <div class="settings-body">
      <p class="muted">
        Своё OAuth-приложение или уже полученный собственный access token.
      </p>
      <label
        >Client ID<input
          bind:value={daClient}
          placeholder={status.config.daClientId || "Client ID"}
          autocomplete="off"
        /></label
      ><label
        >Client secret<input
          type="password"
          bind:value={daSecret}
          placeholder={status.config.hasDaSecret
            ? "Сохранён; пустое поле не меняет"
            : "Client secret"}
          autocomplete="new-password"
        /></label
      >
      <p class="small muted">
        Redirect URI: <code>{status.config.daRedirectUri}</code>.
        <a
          href="https://www.donationalerts.com/application/clients"
          target="_blank"
          rel="noreferrer">Регистрация приложения</a
        >
      </p>
      <details>
        <summary>Подключить собственный токен</summary><label
          >Access token<input
            type="password"
            bind:value={daToken}
            autocomplete="new-password"
          /></label
        ><label
          >Refresh token (если есть)<input
            type="password"
            bind:value={daRefresh}
            autocomplete="new-password"
          /></label
        >
      </details>
      <label
        >Подтверждённый UTC offset времени DA, в минутах<input
          type="number"
          min="-840"
          max="840"
          bind:value={offset}
          placeholder="Неизвестен — оставить пустым"
        /></label
      >
      <p class="small muted">
        Не угадывайте offset: без проверки донаты сохраняются, но не
        приписываются минуте эфира. Offset действует на новые события;
        перепроекция истории появится отдельно.
      </p>
      <div class="actions">
        <button class="primary" disabled={busy} onclick={() => run(donation)}
          >Подключить DonationAlerts</button
        ><button
          class="outline"
          disabled={busy}
          onclick={() =>
            run(async () => {
              await api("donationalerts/disconnect", {});
            })}>Отключить</button
        >
      </div>
      <button
        class="text-button"
        disabled={busy}
        onclick={() =>
          run(async () => {
            await api("donationalerts/rescan", {});
            message = "Повторный импорт запущен.";
          })}>Повторить импорт истории</button
      >
      <p class="small muted">{status.donationalerts.detail}</p>
      {#each Object.entries(status.donationalerts.capabilities || {}) as [key, value]}<div
          class="capability"
        >
          <span>{key}</span><span>{String(value)}</span>
        </div>{/each}
    </div>
  </section>
  <section class="panel settings wide">
    <header><h2>Локальные данные</h2></header>
    <div class="settings-body">
      <p class="muted">
        Данные остаются на этом компьютере. Секреты хранятся отдельно от
        резервной копии базы; облачный backup пока не включён.
      </p>
      <button
        class="outline"
        disabled={busy}
        onclick={() =>
          run(async () => {
            const result = await api("backup", {});
            message = `Резервная копия сохранена: ${result.filename}`;
          })}>Создать резервную копию</button
      >{#if status.gaps?.length}<h3>Пробелы сбора</h3>
        {#each status.gaps as gap}<div class="capability">
            <span>{gap.source}: {gap.reason}</span><span
              >{new Date(gap.started_at_ms).toLocaleString("ru-RU")}</span
            >
          </div>{/each}{/if}
    </div>
  </section>
</div>
{#if error}<p role="alert" class="notice error">{error}</p>{/if}{#if message}<p
    role="status"
    class="notice"
  >
    {message}
  </p>{/if}
