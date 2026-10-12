<script lang="ts">
 import {api} from './api';
 let data=$state<Record<string,Record<string,unknown>>|null>(null),busy=$state(false),visible=$state(false),error=$state('');
 const names:Record<string,string>={twitch:'Twitch',youtube:'YouTube',donationalerts:'DonationAlerts'};
 const labels:Record<string,string>={clientId:'Client ID',clientSecret:'Client secret',access:'Access token',refresh:'Refresh token',userId:'ID аккаунта',expiresAt:'Срок действия',scopes:'Разрешения'};
 async function load(){busy=true;error='';try{data=await api('integrations/credentials',{});}catch(e){error=(e as Error).message;}finally{busy=false;}}
 function close(){data=null;visible=false;error='';}
</script>
<section class="panel settings wide" aria-label="Сохранённые ключи интеграций">
 <header><h2>Ключи интеграций</h2></header>
 <div class="settings-body">
  <p class="small muted">Ключи выбранного профиля. Полная резервная копия сохраняет подключения обоих профилей.</p>
  {#if !data}<button class="outline" disabled={busy} onclick={load}>Загрузить ключи</button>
  {:else}
   <div class="actions"><button class="outline" onclick={()=>visible=!visible}>{visible?'Скрыть значения':'Показать значения'}</button><button class="text-button" onclick={close}>Закрыть ключи</button></div>
   <div class="credentials">{#each Object.entries(data) as [provider,fields]}<div><h3>{names[provider]}</h3>
    {#each Object.entries(fields) as [name,value]}{#if value!==undefined&&value!==''}<label>{labels[name]}<input readonly type={visible?'text':'password'} value={Array.isArray(value)?value.join(', '):String(value)} autocomplete="off" /></label>{/if}{/each}
   </div>{/each}</div>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
 </div>
</section>
<style>.credentials{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:1.5rem;}.credentials>div{min-width:0;}input{width:100%;min-width:0;}</style>
