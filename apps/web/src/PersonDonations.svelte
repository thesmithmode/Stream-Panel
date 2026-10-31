<script lang="ts">
 import PersonPicker from './PersonPicker.svelte';
 import AudioDonation from './AudioDonation.svelte';
 import {isAudioDonation} from './labels';
 import {untrack,onMount} from 'svelte';
 import Icon from './Icon.svelte';
 import {api,date,money} from './api';
 type Donation={id:string;personId:string|null;personName:string|null;amountMinor:string;currency:string;occurredAtMs:number|null;message:string;sourceName:string;originalActorName:string;revision:number;deleted:boolean};
 let {personId,revision=0,onChange}:{personId:string;revision?:number;onChange:()=>Promise<void>}=$props();
 let rows=$state<Donation[]>([]),total=$state(0),offset=$state(0),busy=$state(false),error=$state(''),conflict=$state(false);
 let loaded=$state(false),loading=$state(true),loadedOffset=$state(0);
 let editing=$state<Donation|null>(null),recipient=$state('');
 async function refresh(){
  const ticket=++generation,page=offset;loading=true;
  try{const result=await api(`donations?person=${encodeURIComponent(personId)}&offset=${page}&limit=10&includeDeleted=true`);if(ticket!==generation)return;rows=result.items;total=result.total;loaded=true;loadedOffset=page;if(page>=total&&page>0)offset=Math.max(0,Math.floor(Math.max(0,total-1)/10)*10);}
  catch(e){if(ticket===generation)error=(e as Error).message;throw e;}
  finally{if(ticket===generation)loading=false;}
 }
 $effect(()=>{personId;offset;revision;untrack(()=>void refresh().catch(()=>{}));return()=>{generation++;};});
 onMount(()=>{const update=()=>{if(!editing)void refresh().catch(()=>{});};window.addEventListener('sp:data-refresh',update);return()=>window.removeEventListener('sp:data-refresh',update);});
 async function assign(row:Donation,target:string|null){busy=true;error='';conflict=false;try{await api(`donations/${encodeURIComponent(row.id)}/assign`,{personId:target,revision:row.revision});editing=null;await refresh();await onChange();}catch(e){conflict=(e as Error).message.includes('DONATION_CONFLICT');error=conflict?'Привязка изменилась в другом окне. Загрузите актуальный донат.':(e as Error).message;if(!conflict)await refresh().catch(()=>{});}finally{busy=false;}}
 let generation=0;
 const value=(row:Donation)=>/^\d+$/.test(row.amountMinor)?money(row.amountMinor,row.currency):'Сумма неизвестна';
</script>
<section aria-label="Донаты человека">
 <h3>Донаты · {total}</h3>
 {#if error}<p role="alert">{error}</p>{/if}{#if conflict}<button class="outline" onclick={()=>{editing=null;conflict=false;error='';void refresh().catch(()=>{});}}>Обновить список донатов</button>{/if}
 {#each rows as row (row.id)}<article data-donation-id={row.id}>
  <div class="donation-heading"><strong>{value(row)}</strong><span class="small muted">{date(row.occurredAtMs)}</span></div>
  <span class="small muted">{row.sourceName} · {row.originalActorName||'Аноним'}</span>{#if row.message}<p class="donation-message">{#if isAudioDonation({text:row.message})}<AudioDonation text={row.message}/>{:else}{row.message}{/if}</p>{/if}
  {#if editing?.id===row.id}<form onsubmit={e=>{e.preventDefault();void assign(row,recipient||null);}}><PersonPicker label="Привязать к человеку" bind:value={recipient} nullable={true} disabled={busy||loading}/><button class="primary" disabled={busy||loading}>Сохранить привязку</button><button type="button" class="outline" onclick={()=>editing=null}>Отмена</button></form>
  {:else}<button class="icon-button" aria-label="Изменить привязку" title="Изменить привязку" disabled={busy||loading} onclick={()=>{editing=row;recipient=row.personId??personId;}}><Icon name="pencil" size={18}/></button>{/if}
 </article>{/each}
 {#if loading&&!loaded}<p role="status">Загружаем донаты…</p>{/if}
 {#if !rows.length&&loaded}<p class="muted">Донатов пока нет</p>{/if}
 {#if total>10}<div class="pagination"><button class="outline" disabled={busy||loading||offset===0} onclick={()=>offset=Math.max(0,offset-10)}>Предыдущие донаты</button><span>{loadedOffset+1}–{Math.min(loadedOffset+10,total)} из {total}</span><button class="outline" disabled={busy||loading||offset+10>=total} onclick={()=>offset+=10}>Следующие донаты</button></div>{/if}
</section>
<style>
 section{margin:1rem 0;}form{display:flex;flex-wrap:wrap;gap:.6rem;align-items:end;padding:.8rem 0;}article{padding:.8rem 0;border-bottom:1px solid var(--border);}.donation-heading{display:flex;gap:.7rem;justify-content:space-between;flex-wrap:wrap;}.donation-message{white-space:pre-wrap;overflow-wrap:anywhere;}button{margin:.4rem .4rem .4rem 0;}.pagination{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;}
</style>
