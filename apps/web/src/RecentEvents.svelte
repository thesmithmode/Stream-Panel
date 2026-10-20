<script lang="ts">
 import {api,date,money} from './api';
 let {sessionId='',personId='',messagesOnly=false}:{sessionId?:string;personId?:string;messagesOnly?:boolean}=$props();
 type Row={id:string;source:string;type:string;actor_name:string|null;at_ms:number;payload:Record<string,unknown>};
 let rows=$state<Row[]>([]),offset=$state(0),busy=$state(false),error=$state(''),refresh=$state(0);
 const limit=50;
 const labels:Record<string,string>={'chat.message':'Сообщение',textMessageEvent:'Сообщение',superChatEvent:'Super Chat',superStickerEvent:'Стикер',donation:'Донат','channel.follow':'Подписка','chat.message_delete':'Удаление сообщения','chat.clear':'Очистка чата','chat.clear_user_messages':'Очистка сообщений пользователя'};
 $effect(()=>{void sessionId;void personId;void messagesOnly;offset=0;});
 $effect(()=>{
  const q=new URLSearchParams({offset:String(offset),limit:String(limit),...(sessionId?{session:sessionId}:{}),...(personId?{person:personId}:{}),...(messagesOnly?{messages:'1'}:{})});void refresh;
  const controller=new AbortController();busy=true;error='';rows=[];
  void api<Row[]>(`events/recent?${q}`,undefined,controller.signal).then(result=>{if(!controller.signal.aborted)rows=result;}).catch(e=>{if(!controller.signal.aborted)error=e.message;}).finally(()=>{if(!controller.signal.aborted)busy=false;});
  return()=>controller.abort();
 });
</script>
<div class="recent-events" aria-busy={busy}>
 <p class="small muted">Последние 48 часов · время МСК · сначала новые</p>
 {#if error}<p role="alert">{error}</p>{:else if busy}<p role="status">Загружаем…</p>{:else}
  {#each rows as row (row.id)}
   <article><div class="event-meta"><time>{date(row.at_ms)}</time><span class:twitch={row.source==='twitch'} class:youtube={row.source==='youtube'}>{row.source==='twitch'?'Twitch':row.source==='youtube'?'YouTube':'DonationAlerts'}</span><strong>{row.actor_name??'Без автора'}</strong></div>
    <p>{#if row.payload.redacted}Сообщение удалено модерацией.{:else if typeof row.payload.text==='string'&&row.payload.text}{row.payload.text}{:else}{labels[row.type]??'Событие'}{/if}</p>
    {#if typeof row.payload.amountMinor==='string'&&/^-?\d+$/.test(row.payload.amountMinor)&&typeof row.payload.currency==='string'}<p>{money(row.payload.amountMinor,row.payload.currency)}</p>{/if}
   </article>
  {:else}<p class="muted">{messagesOnly?'Нет сохранённых сообщений за последние 48 часов.':'Нет сохранённых событий этого стрима за последние 48 часов.'}</p>{/each}
 {/if}
 <div class="actions"><button class="outline small" disabled={busy||offset===0} onclick={()=>offset=Math.max(0,offset-limit)}>Назад</button><span class="small">Страница {offset/limit+1}</span><button class="outline small" disabled={busy||rows.length<limit} onclick={()=>offset+=limit}>Далее</button><button class="outline small" disabled={busy} onclick={()=>refresh++}>Обновить</button></div>
</div>
<style>
 .recent-events{min-width:0}.recent-events>p{margin:0 0 12px}article{padding:12px 0;border-bottom:1px solid var(--border);overflow-wrap:anywhere}article p{margin:6px 0;white-space:pre-wrap}.event-meta{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:12px}.event-meta time{color:var(--muted)}.actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:12px}
</style>
