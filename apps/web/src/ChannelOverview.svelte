<script lang="ts">
 import {onMount} from 'svelte';
 import {api,money} from './api';
 import {ConnectionError} from './request';
 import {formatDuration} from './duration';
 let {connect}:{connect:()=>void}=$props();
 interface Totals {streams:number;durationMinutes:number;attendees:number;messages:number;donations:number;totals:Record<string,string>}
 let data=$state<Totals|null>(null),error=$state('');
 onMount(()=>{
  let alive=true,pending=false;
  const refresh=async()=>{if(pending||document.hidden||!navigator.onLine)return;pending=true;try{const value=await api<Totals>('overview');if(alive){data=value;error='';}}catch(e){if(alive&&!(e instanceof ConnectionError))error=(e as Error).message;}finally{pending=false;}};
  void refresh();const timer=setInterval(()=>void refresh(),60000);window.addEventListener('online',refresh);document.addEventListener('visibilitychange',refresh);
  return()=>{alive=false;clearInterval(timer);window.removeEventListener('online',refresh);document.removeEventListener('visibilitychange',refresh);};
 });
</script>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if data}
 <section class="metrics channel-metrics" aria-label="Статистика канала за всю историю">
  <div class="metric"><div><span>Стримы</span><strong>{data.streams}</strong></div></div>
  <div class="metric"><div><span>Время эфиров</span><strong>{formatDuration(data.durationMinutes)}</strong></div></div>
  <div class="metric"><div><span>Участники чата</span><strong>{data.attendees}</strong></div></div>
  <div class="metric"><div><span>Сообщения</span><strong>{data.messages.toLocaleString('ru-RU')}</strong></div></div>
  <div class="metric"><div><span>Донаты</span><strong>{data.donations}</strong></div></div>
  <div class="metric"><div><span>Сумма донатов</span>{#each Object.entries(data.totals) as [currency,amount]}<strong>{money(amount,currency)}</strong>{:else}<strong>—</strong>{/each}</div></div>
 </section>
 {#if !data.streams}<section class="panel"><div class="empty-small"><p>Стримы появятся автоматически после подключения площадок.</p><button class="primary" onclick={connect}>Открыть интеграции</button></div></section>{/if}
{:else}<p class="muted" role="status">Загружаем итоги…</p>{/if}
