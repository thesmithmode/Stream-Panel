<script lang="ts">
 import {untrack,onMount} from 'svelte';
 import {api,date,money,type Person} from './api';
 import {donationAuditChanges} from './donation-form';
 type Donation={id:string;personId:string|null;personName:string|null;amountMinor:string;currency:string;occurredAtMs:number|null;message:string;sourceName:string;originalActorName:string;revision:number;deleted:boolean};
 type Audit={id:string;revision:number;kind:string;created_at_ms:number;before_json:string;after_json:string};
 let {personId,people,revision=0,onChange}:{personId:string;people:Person[];revision?:number;onChange:()=>Promise<void>}=$props();
 let rows=$state<Donation[]>([]),total=$state(0),offset=$state(0),busy=$state(false),error=$state(''),conflict=$state(false);
 let loading=$state(true),loadedOffset=$state(0);
 let editing=$state<Donation|null>(null),recipient=$state('');
 let histories=$state<Record<string,Audit[]>>({});let generation=0;
 async function refresh(){
  const ticket=++generation,page=offset;loading=true;
  try{const result=await api(`donations?person=${encodeURIComponent(personId)}&offset=${page}&limit=10&includeDeleted=true`);if(ticket!==generation)return;rows=result.items;total=result.total;loadedOffset=page;if(page>=total&&page>0)offset=Math.max(0,Math.floor(Math.max(0,total-1)/10)*10);}
  catch(e){if(ticket===generation)error=(e as Error).message;throw e;}
  finally{if(ticket===generation)loading=false;}
 }
 $effect(()=>{personId;offset;revision;untrack(()=>void refresh().catch(()=>{}));return()=>{generation++;};});
 onMount(()=>{const update=()=>{if(!editing)void refresh().catch(()=>{});};window.addEventListener('sp:data-refresh',update);return()=>window.removeEventListener('sp:data-refresh',update);});
 async function audit(id:string){histories[id]=await api(`donations/${encodeURIComponent(id)}/audit`);}
 async function assign(row:Donation,target:string|null){busy=true;error='';conflict=false;try{await api(`donations/${encodeURIComponent(row.id)}/assign`,{personId:target,revision:row.revision});editing=null;await refresh();await onChange();}catch(e){conflict=(e as Error).message.includes('DONATION_CONFLICT');error=conflict?'Привязка изменилась в другом окне. Загрузите актуальный донат.':(e as Error).message;if(!conflict)await refresh().catch(()=>{});}finally{busy=false;}}
 const value=(row:Donation)=>/^\d+$/.test(row.amountMinor)?money(row.amountMinor,row.currency):'Сумма неизвестна';
</script>
<section aria-label="Донаты человека">
 <h3>Донаты · {total}</h3>
 {#if error}<p role="alert">{error}</p>{/if}{#if conflict}<button class="outline" onclick={()=>{editing=null;conflict=false;error='';void refresh().catch(()=>{});}}>Обновить список донатов</button>{/if}
 {#each rows as row (row.id)}<article data-donation-id={row.id}>
  <div class="donation-heading"><strong>{value(row)}</strong><span class="small muted">{date(row.occurredAtMs)}</span></div>
  <span class="small muted">{row.sourceName} · {row.originalActorName||'Аноним'}</span>{#if row.message}<p class="donation-message">{row.message}</p>{/if}
  {#if editing?.id===row.id}<form onsubmit={e=>{e.preventDefault();void assign(row,recipient);}}><label>Привязать к человеку<select aria-label="Привязать к человеку" bind:value={recipient} disabled={busy||loading}>{#each people.filter(p=>!p.is_bot) as person}<option value={person.id}>{person.display_name}</option>{/each}</select></label><button class="primary" disabled={busy||loading||!recipient}>Сохранить привязку</button><button type="button" class="outline" onclick={()=>editing=null}>Отмена</button></form>
  {:else}<button class="outline" disabled={busy||loading} onclick={()=>{editing=row;recipient=row.personId??personId;}}>Изменить привязку</button><button class="outline" disabled={busy||loading} onclick={()=>assign(row,null)}>Открепить от человека</button>{/if}
  <details ontoggle={e=>{if(e.currentTarget.open)void audit(row.id).catch(e=>error=e.message);}}><summary>История привязок</summary>{#each histories[row.id]??[] as entry}<div class="audit-entry"><p class="small">{date(entry.created_at_ms)}</p>{#each donationAuditChanges(entry.before_json,entry.after_json) as change}<p class="small donation-message">{change.label}: {change.before??''} → {change.after}</p>{/each}</div>{/each}</details>
 </article>{/each}
 {#if loading}<p role="status">Загружаем донаты…</p>{/if}
 {#if !rows.length&&!loading}<p class="muted">Донатов пока нет</p>{/if}
 {#if total>10}<div class="pagination"><button class="outline" disabled={busy||loading||offset===0} onclick={()=>offset=Math.max(0,offset-10)}>Предыдущие донаты</button><span>{loadedOffset+1}–{Math.min(loadedOffset+10,total)} из {total}</span><button class="outline" disabled={busy||loading||offset+10>=total} onclick={()=>offset+=10}>Следующие донаты</button></div>{/if}
</section>
<style>
 section{margin:1rem 0;}form{display:flex;flex-wrap:wrap;gap:.6rem;align-items:end;padding:.8rem 0;}label{display:grid;gap:.3rem;}select{width:100%;min-width:0;}article{padding:.8rem 0;border-bottom:1px solid var(--border);}.donation-heading{display:flex;gap:.7rem;justify-content:space-between;flex-wrap:wrap;}.donation-message{white-space:pre-wrap;overflow-wrap:anywhere;}button{margin:.4rem .4rem .4rem 0;}details{margin:.5rem 0;}summary{cursor:pointer;}.audit-entry{padding:.4rem 0;border-top:1px solid var(--border);}.pagination{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;}
</style>
