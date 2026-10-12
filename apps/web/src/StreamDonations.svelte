<script lang="ts">
 import {onMount,untrack} from 'svelte';
 import {api,date,money,type Person} from './api';
 type Donation={id:string;personId:string|null;personName:string|null;amountMinor:string;currency:string;occurredAtMs:number|null;message:string;originalActorName:string;revision:number};
 type Candidate={id:string;name:string;messages:number};
 let {sessionId,onPerson,changed}:{sessionId:string;onPerson:(id:string)=>void;changed:()=>Promise<void>}=$props();
 let rows=$state<Donation[]>([]),total=$state(0),offset=$state(0),loading=$state(false),busy=$state(false),error=$state('');
 let editing=$state<Donation|null>(null),candidates=$state<Candidate[]>([]),people=$state<Person[]>([]),recipient=$state(''),search=$state(''),finding=$state(false);
 const value=(row:Donation)=>/^\d+$/.test(row.amountMinor)?money(row.amountMinor,row.currency):'Сумма неизвестна';
 let generation=0,editorGeneration=0;
 async function refresh(){const ticket=++generation;loading=true;try{const result=await api(`donations?session=${encodeURIComponent(sessionId)}&offset=${offset}&limit=10`);if(ticket===generation){rows=result.items;total=result.total;error='';}}catch(e){if(ticket===generation)error=(e as Error).message;}finally{if(ticket===generation)loading=false;}}
 $effect(()=>{sessionId;offset;untrack(()=>void refresh());return()=>{generation++;};});
 onMount(()=>{const update=()=>void refresh();window.addEventListener('sp:data-refresh',update);return()=>{editorGeneration++;window.removeEventListener('sp:data-refresh',update);};});
 async function edit(row:Donation){const ticket=++editorGeneration;editing=row;recipient=row.personId??'';candidates=[];people=[];search='';finding=true;error='';try{const [suggested,all]=await Promise.all([api<Candidate[]>(`donations/${encodeURIComponent(row.id)}/candidates`),api<Person[]>('persons')]);if(ticket===editorGeneration){candidates=suggested;people=all.filter(p=>!p.is_bot);}}catch(e){if(ticket===editorGeneration)error=(e as Error).message;}finally{if(ticket===editorGeneration)finding=false;}}
 $effect(()=>{const term=search.trim();if(!editing||!term)return;let cancelled=false;const timer=setTimeout(()=>void api<Person[]>(`persons?search=${encodeURIComponent(term)}`).then(result=>{if(!cancelled)people=result.filter(p=>!p.is_bot);}).catch(e=>{if(!cancelled)error=e.message;}),200);return()=>{cancelled=true;clearTimeout(timer);};});
 async function assign(){if(!editing||!recipient)return;busy=true;error='';try{await api(`donations/${encodeURIComponent(editing.id)}/assign`,{personId:recipient,revision:editing.revision});editing=null;editorGeneration++;await refresh();await changed();}catch(e){error=(e as Error).message==='DONATION_CONFLICT'?'Привязка уже изменилась. Закройте форму и откройте донат снова.':(e as Error).message;await refresh();}finally{busy=false;}}
 async function rescan(){busy=true;error='';try{await api('donationalerts/rescan?recent=1',{},AbortSignal.timeout(60000));await refresh();await changed();}catch(e){error=(e as Error).message;}finally{busy=false;}}
</script>
<section class="panel stream-donations" aria-label="Донаты стрима">
 <header><h2>Донаты стрима <span class="small muted">{total}</span></h2><button class="outline small" disabled={busy||loading} onclick={rescan}>{busy?'Обновляем…':'Обновить донаты'}</button></header>
 <div class="donation-list">
 {#if error}<p class="notice error" role="alert">{error}</p>{/if}
 {#each rows as row (row.id)}<article data-donation-id={row.id}>
  <div class="donation-summary"><strong>{value(row)}</strong><time class="small muted">{date(row.occurredAtMs)}</time></div>
  <div class="donation-owner"><span><span class="small muted">Отправитель: </span>{row.originalActorName||'Аноним'}</span>{#if row.personId}<button class="text-button" aria-label={`Связан: ${row.personName}`} onclick={()=>onPerson(row.personId!)}><span class="small muted">Связан: </span>{row.personName}</button>{/if}<button class="outline small" disabled={busy} onclick={()=>void edit(row)}>Привязать к человеку</button></div>
  {#if row.message}<p class="donation-message">{row.message}</p>{/if}
  {#if editing?.id===row.id}<form class="donation-editor" onsubmit={e=>{e.preventDefault();void assign();}}>
   {#if finding}<p class="small muted" role="status">Ищем участников…</p>{:else if candidates.length}<p class="small muted">Писали в чат за 2 минуты до и после доната — выберите, если узнаёте человека.</p><div class="candidate-list">{#each candidates as candidate}<button type="button" class="outline small" class:active={recipient===candidate.id} onclick={()=>recipient=candidate.id}>{candidate.name}<span class="muted">{candidate.messages} сообщ.</span></button>{/each}</div>{:else}<p class="small muted">{row.occurredAtMs===null?'Время доната неизвестно: подсказки по чату недоступны.':'В этом интервале сообщений нет. Найдите человека по имени.'}</p>{/if}
   <label>Поиск человека<input bind:value={search} placeholder="Имя или ник" /></label>
   <label>Получатель привязки<select aria-label="Получатель привязки доната" bind:value={recipient}><option value="">Выберите человека</option>{#each people as person}<option value={person.id}>{person.display_name}</option>{/each}</select></label>
   <div class="actions"><button class="primary small" disabled={busy||finding||!recipient}>Сохранить привязку</button><button type="button" class="outline small" onclick={()=>{editing=null;editorGeneration++;}}>Отмена</button></div>
  </form>{/if}
 </article>{/each}
 {#if loading&&!rows.length}<p class="muted" role="status">Загружаем донаты…</p>{:else if !rows.length}<p class="muted">Донатов в этом стриме пока нет.</p>{/if}
 {#if total>10}<div class="actions"><button class="outline small" disabled={loading||offset===0} onclick={()=>offset-=10}>Предыдущие</button><span class="small muted">{offset+1}–{Math.min(offset+10,total)} из {total}</span><button class="outline small" disabled={loading||offset+10>=total} onclick={()=>offset+=10}>Следующие</button></div>{/if}
 </div>
</section>
<style>
header{gap:12px;flex-wrap:wrap;}h2{display:flex;align-items:baseline;gap:10px;}.donation-list{padding:0 18px 12px;}article{padding:14px 0;border-bottom:1px solid var(--border);}article:last-child{border-bottom:0;}.donation-summary,.donation-owner{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}.donation-summary{justify-content:space-between;margin-bottom:8px;}.donation-summary strong{color:#fff;font-size:20px;}.donation-owner>button:last-child{margin-left:auto;}.donation-message{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;color:#fff;}.donation-editor{display:grid;gap:10px;padding:14px;border-radius:8px;background:var(--bg);margin-top:12px;}.donation-editor label{display:grid;gap:6px;color:var(--muted);font-size:12px;}.donation-editor input,.donation-editor select{min-width:0;width:100%;}.candidate-list{display:flex;gap:8px;flex-wrap:wrap;}.candidate-list button{display:flex;gap:8px;}.candidate-list button.active{border-color:var(--accent);}@media(max-width:600px){.donation-list{padding:0 12px 12px;}.donation-owner>button:last-child{margin-left:0;}.donation-summary time{font-size:11px;}}
</style>
