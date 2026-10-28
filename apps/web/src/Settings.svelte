<script lang="ts">
 import Help from './Help.svelte';
 import {api} from './api';import BackupFiles from './BackupFiles.svelte';
 let {profile,status}:{profile:string;status:any}=$props();
 const canManageBackups=$derived(status.user?.canManageBackups ?? !status.serverMode);
 let rules=$state<any>(null),busy=$state(false),message=$state(''),error=$state('');
 $effect(()=>{void profile;let cancelled=false;void api('settings').then(value=>{if(!cancelled)rules=value;}).catch(e=>{if(!cancelled)error=e.message;});return()=>{cancelled=true;};});
 async function backup(){busy=true;error='';message='';try{const result=await api('backup',{});message=result.cloudError?'Локальная копия сохранена. Облачная загрузка не удалась.':`Резервная копия: ${result.filename}`;}catch(e){error=(e as Error).message;}finally{busy=false;}}
 async function save(){busy=true;error='';message='';try{rules=await api('settings',rules);message='Настройки профиля сохранены.';}catch(e){error=(e as Error).message;}finally{busy=false;}}
</script>
<section class="panel profile-settings"><header><h2>Аналитика · {profile==='gulnaz'?'Гульназ':'Руслан'}</h2><Help id="profile-rules-help" label="О правилах аналитики" text="Правила применяются к истории выбранного профиля. Ручная отметка ядра в карточке человека имеет приоритет. Порог — доля эфиров с суммарной активностью не менее 20% длительности. Активность связанных площадок объединяется."/></header>
 {#if rules}<form class="settings-body" onsubmit={e=>{e.preventDefault();void save();}}>
  <div class="settings-fields">
   <label>Порог посещаемости, %<input type="number" min="0" max="100" step="1" required bind:value={rules.regularThresholdPercent}/></label>
   <label>Окно активности YouTube, мин<input type="number" min="1" max="30" required bind:value={rules.chatWindowMinutes}/></label>
   <label>Часовой пояс аналитики<select bind:value={rules.timezone}><option value="Europe/Moscow">Москва</option><option value="UTC">UTC</option><option value="Asia/Yekaterinburg">Екатеринбург</option></select></label>
  </div><button class="primary" disabled={busy}>{busy?'Сохраняем…':'Сохранить настройки'}</button>
 </form>{:else}<p class="settings-body" role="status">Загружаем настройки…</p>{/if}
 {#if message}<p class="settings-body" role="status">{message}</p>{/if}{#if error}<p class="settings-body notice error" role="alert">{error}</p>{/if}
</section>
{#if canManageBackups&&status.storage?.freeBytes!==null&&status.storage?.freeBytes!==undefined}<section class="panel"><header><h2>Хранение на сервере</h2></header><div class="settings-body"><p>Свободно: {(status.storage.freeBytes/1024**3).toFixed(1)} ГБ</p><details><summary>Очистка и хранение</summary><p class="small muted">При свободном месте меньше 1 ГБ запускается очистка старых копий; сбор продолжает работать. Запись останавливается только при критическом остатке 16 МБ. Redis: до 128 МБ, без записи на диск; локальный кэш: до 8 МБ на профиль.</p><p class="small muted">Локальные копии очищаются автоматически: сохраняются семь последних точек восстановления и выбранные дневные/недельные копии. Дополнительные копии ограничены бюджетом 2 ГБ; семь последних имеют приоритет.</p></details></div></section>{/if}
{#if canManageBackups}<section class="panel"><header><h2>Резервные копии</h2></header><div class="settings-body"><button class="outline" disabled={busy} onclick={backup}>Создать резервную копию</button>
{#if status.backup}<p class="small muted">Резервная копия общая для обоих профилей.</p><BackupFiles status={status.backup}/>{/if}</div></section>
{/if}
<style>.settings-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:16px;margin:16px 0;}label{display:grid;gap:6px;align-content:start;}input,select{width:100%;min-width:0;}</style>
