<script lang="ts">
 import {untrack} from 'svelte';
 import {api,date,money,type Person} from './api';
 import {decimalAmount,localDonationTime,donationTimestamp,normalizedDonationAmount,donationAuditChanges} from './donation-form';
 import Help from './Help.svelte';
 type Donation={id:string;personId:string|null;personName:string|null;amountMinor:string;currency:string;occurredAtMs:number|null;message:string;sourceName:string;originalActorName:string;revision:number;deleted:boolean};
 type Audit={id:string;revision:number;kind:string;created_at_ms:number;before_json:string;after_json:string};
 let {personId,people,onChange}:{personId:string;people:Person[];onChange:()=>Promise<void>}=$props();
 let rows=$state<Donation[]>([]),total=$state(0),offset=$state(0),includeDeleted=$state(false),busy=$state(false),error=$state('');
 let formOpen=$state(false),editing=$state<Donation|null>(null),amount=$state(''),currency=$state('RUB'),time=$state(''),message=$state(''),source=$state('Ручной'),recipient=$state(''),conflict=$state(false);
 let histories=$state<Record<string,Audit[]>>({});let generation=0;
 async function refresh(){
  const ticket=++generation;
  let result:{items:Donation[];total:number};
  try{result=await api(`donations?person=${encodeURIComponent(personId)}&offset=${offset}&limit=10&includeDeleted=${includeDeleted}`);}catch(e){if(ticket===generation)throw e;return;}
  if(ticket===generation){rows=result.items;total=result.total;if(offset>=total&&offset>0)offset=Math.max(0,Math.floor(Math.max(0,total-1)/10)*10);}
 }
 $effect(()=>{personId;offset;includeDeleted;untrack(()=>{void refresh().catch(e=>error=e.message);});return()=>{generation++;};});
 function openForm(row:Donation|null){editing=row;formOpen=true;conflict=false;error='';amount=row?decimalAmount(row.amountMinor):'';currency=row?.currency||'RUB';time=localDonationTime(row?row.occurredAtMs:Date.now());message=row?.message??'';source=row?.sourceName??'Ручной';recipient=row?.personId??personId;}
 async function audit(id:string){histories[id]=await api(`donations/${encodeURIComponent(id)}/audit`);}
 async function change(action:()=>Promise<unknown>,id?:string){
  busy=true;error='';conflict=false;
  try{await action();await refresh();if(id&&histories[id])await audit(id);await onChange();}
  catch(e){const code=(e as Error).message;conflict=code.includes('DONATION_CONFLICT');error=conflict?'Донат изменился в другом окне. Ваши поля сохранены; загрузите актуальную запись перед повторным сохранением.':code;try{await refresh();}catch{/* Preserve draft and error while offline. */}}
  finally{busy=false;}
 }
 async function save(){
  await change(async()=>{
   const at=donationTimestamp(time,editing?.occurredAtMs??null);
   if(!editing&&at===null)throw new Error('Укажите дату и время доната');
   const input={personId:recipient,amount:normalizedDonationAmount(amount),currency,occurredAtMs:at,message,sourceName:source};
   if(editing)await api(`donations/${encodeURIComponent(editing.id)}/update`,{...input,revision:editing.revision});else await api('donations',input);
   formOpen=false;
  },editing?.id);
 }
 const label=(kind:string)=>({create:'Ручной донат',update:'Изменение',delete:'Удаление',restore:'Восстановление'} as Record<string,string>)[kind]??'Исправление';
 const value=(row:Donation)=>decimalAmount(row.amountMinor)?money(row.amountMinor,row.currency):'Сумма неизвестна';
</script>
<section aria-label="Донаты человека">
 <h3>Донаты <Help id="person-donations-help" label="Об исправлениях донатов" text="Исправления и удаления сохраняются в истории. Переназначение касается только выбранного доната; остальные донаты этого человека не меняются. Удалённый донат можно восстановить." /></h3>
 {#if !formOpen}<button class="outline" disabled={busy} onclick={()=>openForm(null)}>Добавить донат</button>{/if}
 <label class="check"><input type="checkbox" bind:checked={includeDeleted} disabled={busy}/> Показать удалённые донаты</label>
 {#if error}<p role="alert">{error}</p>{/if}
 {#if conflict&&editing}<button class="outline" disabled={busy} onclick={()=>change(async()=>openForm(await api(`donations/${encodeURIComponent(editing!.id)}`)))}>Загрузить актуальный донат</button>{/if}
 {#if formOpen}<form onsubmit={e=>{e.preventDefault();void save();}}>
  <label>Получатель<select aria-label="Получатель" bind:value={recipient} disabled={busy}>{#each people as person}<option value={person.id}>{person.display_name}</option>{/each}</select></label>
  <div class="form-row"><label>Сумма<input inputmode="decimal" bind:value={amount} required maxlength="50" disabled={busy}/></label><label>Валюта<select aria-label="Валюта" bind:value={currency} disabled={busy}>{#each ['RUB','USD','EUR','BYN','KZT','UAH','BRL','TRY'] as code}<option value={code}>{code}</option>{/each}</select></label></div>
  <label>Дата и время доната<input type="datetime-local" step="1" bind:value={time} required={!editing} disabled={busy}/></label>
  <label>Источник доната<input bind:value={source} required maxlength="200" disabled={busy}/></label>
  <label>Сообщение доната<textarea bind:value={message} maxlength="10000" rows="3" disabled={busy}></textarea></label>
  <button class="primary" disabled={busy||editing?.deleted}>{editing?'Сохранить донат':'Добавить донат'}</button>
  <button type="button" class="outline" disabled={busy} onclick={()=>{formOpen=false;conflict=false;}}>Отмена</button>
 </form>{/if}
 {#each rows as row (row.id)}<article data-donation-id={row.id} class:deleted={row.deleted}>
  <div class="donation-heading"><strong>{value(row)}</strong><span class="small muted">{date(row.occurredAtMs)}{#if row.deleted} · Удалён{/if}</span></div>
  <span class="small muted">{row.sourceName}</span>{#if row.message}<p class="donation-message">{row.message}</p>{/if}
  {#if row.deleted}<button class="outline" disabled={busy} onclick={()=>change(()=>api(`donations/${encodeURIComponent(row.id)}/restore`,{revision:row.revision}),row.id)}>Восстановить донат</button>
  {:else}<button class="outline" disabled={busy} onclick={()=>openForm(row)}>Редактировать донат</button><button class="outline" disabled={busy} onclick={()=>change(()=>api(`donations/${encodeURIComponent(row.id)}/delete`,{revision:row.revision}),row.id)}>Удалить донат</button>{/if}
  <details ontoggle={e=>{if(e.currentTarget.open)void audit(row.id).catch(e=>error=e.message);}}><summary>История исправлений</summary>
   <p class="small muted">Исходный донатер: {row.originalActorName||'Аноним'}</p>
   {#each histories[row.id]??[] as entry}<div class="audit-entry"><p class="small">{date(entry.created_at_ms)} · {label(entry.kind)}</p>{#each donationAuditChanges(entry.before_json,entry.after_json) as change}<p class="small donation-message"><strong>{change.label}:</strong> {#if change.before!==null}{change.before} → {/if}{change.after}</p>{/each}</div>{/each}
  </details>
 </article>{/each}
 {#if !rows.length}<p class="muted">Донатов пока нет</p>{/if}
 {#if total>10}<div class="pagination"><button class="outline" disabled={busy||offset===0} onclick={()=>offset=Math.max(0,offset-10)}>Предыдущие донаты</button><span>{offset+1}–{Math.min(offset+10,total)} из {total}</span><button class="outline" disabled={busy||offset+10>=total} onclick={()=>offset+=10}>Следующие донаты</button></div>{/if}
</section>
<style>
 section{margin:1.5rem 0;}form{display:grid;gap:.7rem;padding:1rem 0;}label{display:grid;gap:.3rem;}label.check{display:flex;margin:.7rem 0;align-items:center;}input,select,textarea{width:100%;min-width:0;box-sizing:border-box;}label.check input{width:auto;}.form-row{display:grid;grid-template-columns:minmax(0,1fr) 90px;gap:.7rem;}textarea{resize:vertical;background:#101319;color:#e8e9ef;border:1px solid var(--border);border-radius:6px;padding:.7rem;font:inherit;}article{padding:1rem 0;border-bottom:1px solid var(--border);}.donation-heading{display:flex;gap:.7rem;justify-content:space-between;flex-wrap:wrap;}.donation-message{white-space:pre-wrap;overflow-wrap:anywhere;}button{margin:.5rem .5rem .5rem 0;}details{margin:.6rem 0;}summary{cursor:pointer;}.audit-entry{padding:.4rem 0;border-top:1px solid var(--border);}.deleted{opacity:.7;}.pagination{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;}
</style>
