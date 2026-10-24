<script lang="ts">
 import AudioDonation from './AudioDonation.svelte';
 import {isAudioDonation} from './labels';
 import {api,date,money} from './api';
 let {sessionId='',personId='',messagesOnly=false}:{sessionId?:string;personId?:string;messagesOnly?:boolean}=$props();
 type Row={id:string;source:string;type:string;actor_name:string|null;at_ms:number;payload:Record<string,unknown>};
 let rows=$state<Row[]>([]),offset=$state(0),busy=$state(false),error=$state(''),refresh=$state(0);
 const limit=50;
 const clock=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit',second:'2-digit'});
 const calendar=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long',year:'numeric'});
 const sourceName=(source:string)=>source==='twitch'?'Twitch':source==='youtube'?'YouTube':'DonationAlerts';
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
 <p class="small muted">48 часов · МСК · новые сверху</p>
 {#if error}<p role="alert">{error}</p>{:else if busy}<p role="status">Загружаем…</p>{:else}
  {#each rows as row,index (row.id)}
   {#if index===0||calendar.format(row.at_ms)!==calendar.format(rows[index-1]!.at_ms)}<h3 class="event-day">{calendar.format(row.at_ms)}</h3>{/if}
   <article><time datetime={new Date(row.at_ms).toISOString()} title={date(row.at_ms)}>{clock.format(row.at_ms)}</time>{' '}<strong class="event-author" class:twitch={row.source==='twitch'} class:youtube={row.source==='youtube'} title={`${row.actor_name??'Без автора'} · ${sourceName(row.source)}`} aria-label={`${row.actor_name??'Без автора'} · ${sourceName(row.source)}`}>{row.actor_name??'Без автора'}:</strong>{' '}<span class="event-text">{#if row.payload.redacted}Сообщение удалено модерацией.{:else if typeof row.payload.text==='string'&&row.payload.text}{#if isAudioDonation(row.payload)}<AudioDonation text={row.payload.text}/>{:else}{row.payload.text}{/if}{:else}{labels[row.type]??'Событие'}{/if}</span>
    {#if typeof row.payload.amountMinor==='string'&&/^-?\d+$/.test(row.payload.amountMinor)&&typeof row.payload.currency==='string'}{' '}<strong class="event-amount">{money(row.payload.amountMinor,row.payload.currency)}</strong>{/if}
   </article>
  {:else}<p class="muted">{messagesOnly?'Нет сохранённых сообщений за последние 48 часов.':'Нет сохранённых событий этого стрима за последние 48 часов.'}</p>{/each}
 {/if}
 <div class="actions"><button class="outline small" disabled={busy||offset===0} onclick={()=>offset=Math.max(0,offset-limit)}>Назад</button><span class="small">Страница {offset/limit+1}</span><button class="outline small" disabled={busy||rows.length<limit} onclick={()=>offset+=limit}>Далее</button><button class="outline small" disabled={busy} onclick={()=>refresh++}>Обновить</button></div>
</div>
<style>
 .recent-events{min-width:0}.recent-events>p{margin:0 0 8px}.event-day{font-size:12px;font-weight:500;color:var(--muted);margin:12px 0 4px}article{padding:5px 0;border-bottom:1px solid var(--border);font-size:13px;line-height:1.5;overflow-wrap:anywhere}time{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;margin-right:4px}.event-author{display:inline-block;max-width:min(40%,24ch);vertical-align:bottom;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600}.twitch{color:var(--twitch,#a970ff)}.youtube{color:var(--youtube,#ff5959)}.event-text{white-space:pre-wrap}.event-amount{white-space:nowrap}.actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:12px}
</style>
