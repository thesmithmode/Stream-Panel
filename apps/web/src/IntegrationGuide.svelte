<script lang="ts">
 let {provider,redirect=''}:{provider:'Twitch'|'DonationAlerts'|'YouTube';redirect?:string}=$props();
 let open=$state(false);const id=$props.id();
</script>
<button type="button" class="outline small" aria-label={`Инструкция ${provider}`} aria-expanded={open} aria-controls={id} onclick={()=>open=!open}>Инструкция</button>
{#if open}
 <section id={id} class="integration-guide" aria-label={`Подключение ${provider}`}>
  <p class="small">Сначала выберите профиль слева снизу. Подключайте аккаунт его владельца.</p>
  <ol>
   {#if provider==='Twitch'}
    <li>Откройте <a href="https://dev.twitch.tv/console/apps" target="_blank" rel="noreferrer">Twitch Developer Console</a> и зарегистрируйте приложение типа Public. Twitch требует включённую двухфакторную аутентификацию.</li>
    <li>Скопируйте Client ID в поле Twitch. Оставьте включённым полный сбор событий.</li>
    <li>Нажмите «Войти через Twitch», откройте страницу входа, введите показанный код и подтвердите разрешения.</li>
    <li>Дождитесь статуса «подключено». Для новых разрешений подключите Twitch повторно. Награды доступны каналам, у которых Twitch включает баллы.</li>
   {:else if provider==='DonationAlerts'}
    <li>Откройте <a href="https://www.donationalerts.com/application/clients" target="_blank" rel="noreferrer">приложения DonationAlerts</a> и создайте приложение.</li>
    <li>Укажите точный Redirect URI: <code>{redirect}</code></li>
    <li>Скопируйте Client ID и Client Secret из приложения. Secret — секретный ключ, а не адрес.</li>
    <li>В «Дополнительно» задайте UTC offset времени истории DA: 180, если кабинет отдаёт московское время. Без настройки время остаётся неизвестным.</li>
    <li>Нажмите «Подключить DonationAlerts» и подтвердите доступ. После подключения можно запустить повторный импорт истории.</li>
   {:else}
    <li>Создайте проект в <a href="https://console.cloud.google.com/apis/dashboard" target="_blank" rel="noreferrer">Google Cloud Console</a>. Включите YouTube Data API v3 и YouTube Analytics API.</li>
    <li>Настройте экран OAuth consent. В режиме Testing добавьте свой аккаунт в Test users; этот режим может требовать повторного подключения.</li>
    <li>Создайте OAuth Client ID типа Web application. В Authorized redirect URIs добавьте: <code>{redirect}</code></li>
    <li>Скопируйте Client ID и Client secret. Нажмите «Войти через YouTube», выберите аккаунт нужного канала и разрешите чтение канала и аналитики.</li>
    <li>Дождитесь статуса «подключено». Сообщения начнут собираться при активном эфире с включённым чатом.</li>
   {/if}
  </ol>
 </section>
{/if}
<style>
 .integration-guide{flex-basis:100%;padding:12px 0;line-height:1.6;font-size:.85rem;text-align:left;}
 ol{padding-left:1.2rem;margin:0;}li+li{margin-top:.6rem;}code{overflow-wrap:anywhere;white-space:normal;}
</style>
