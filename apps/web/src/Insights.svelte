<script lang="ts">
 import {untrack} from 'svelte';
 import Icon from './Icon.svelte';
 import {dateTime} from './format';
 const disclosureId=$props.id();
 import {api,type InsightCard} from './api';
 import {ConnectionError} from './request';
 let {report,sessionId='',refreshToken,loading=false,onPerson,onStream}:{report?:any;sessionId?:string;refreshToken?:unknown;loading?:boolean;onPerson:(id:string)=>void;onStream?:(id:string)=>void}=$props();
 const groups=[{id:'all',label:'Все'},{id:'schedule',label:'Расписание'},{id:'people',label:'Люди'},{id:'content',label:'Контент'},{id:'support',label:'Поддержка'},{id:'stream',label:'Эфиры'}];
 let opened=$state(false),local=$state<any>(null),busy=$state(false),error=$state(''),group=$state('all'),limit=$state(3),retry=$state(0);
 const data=$derived(report??local),cards=$derived(((data?.insights??[]) as InsightCard[]).filter(card=>!['chat_regular','silent_regular'].includes(card.kind))),filtered=$derived(cards.filter(c=>group==='all'||c.group===group));
 const countFindings=(topic:string)=>cards.filter(c=>topic==='all'||c.group===topic).length;
 $effect(()=>{void group;void sessionId;void report;limit=3;});
 $effect(()=>{if(group!=='all'&&cards.length&&!cards.some(c=>c.group===group))group='all';});
 $effect(()=>{
  const id=sessionId,token=refreshToken,attempt=retry;void token;void attempt;
  if(!id)return;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  untrack(()=>{busy=true;error='';local=null;});
  let cutoff:number|undefined;
  const load=async()=>{
   try{const q=new URLSearchParams({session:id});if(cutoff!==undefined)q.set('to',String(cutoff));const result=await api(`insights?${q}`,undefined,controller.signal);if(controller.signal.aborted)return;
    if(Number.isSafeInteger(result.comparisonToMs))cutoff=result.comparisonToMs;
    if(result.preparing){timer=setTimeout(()=>void load(),250);return;}
    local=result;busy=false;
   }catch(e){if(controller.signal.aborted)return;busy=false;error=e instanceof ConnectionError?'Не удалось загрузить инсайты. Проверь соединение.':(e as Error).message;}
  };void load();
  return()=>{controller.abort();clearTimeout(timer);};
 });
</script>
{#snippet finding(card:InsightCard)}
 <p>{card.detail}</p>
 <div class="evidence">{#if card.basis&&card.kind!=='support_concentration'}<p class="small muted">{card.basis}</p>{/if}{#if card.action}<p class="small">{card.action}</p>{/if}<ul>{#each card.evidence.slice(0,3) as item}<li>{#if onStream}<button class="text-button small" onclick={()=>onStream?.(item.sessionId)}>{dateTime(item.at)} · {item.label}</button>{:else}<span class="small">{dateTime(item.at)} · {item.label}</span>{/if}</li>{/each}</ul></div>
 {#if card.personId}<button class="text-button small insight-person" onclick={()=>onPerson(card.personId!)}>Открыть человека</button>{/if}
{/snippet}
<section class="panel insights-section" aria-label="Инсайты">
 <header><h2><button class="disclosure-toggle" aria-expanded={opened} aria-controls={disclosureId} onclick={()=>opened=!opened}>Инсайты<Icon name="arrow" size={18}/></button></h2></header>
 {#if opened}<div class="insight-body" id={disclosureId}>
  {#if (busy||loading||data?.preparing)&&!data?.insights}<p class="muted" role="status">Ищем закономерности…</p>
  {:else if error}<p class="notice error" role="alert">{error}</p><button class="outline small" onclick={()=>retry++}>Повторить</button>
  {:else if !cards.length}<p class="muted">{sessionId?'Заметных особенностей этого эфира пока не найдено.':'Для выбранного периода пока недостаточно данных для выводов.'}</p>
  {:else}
   {#if new Set(cards.map(c=>c.group)).size>1}<div class="insight-filters" aria-label="Темы инсайтов">{#each groups.filter(g=>g.id==='all'||cards.some(c=>c.group===g.id)) as g}<button class:active={group===g.id} aria-pressed={group===g.id} onclick={()=>group=g.id}>{g.label} <span>{countFindings(g.id)}</span></button>{/each}</div>{/if}
   <div class="insight-grid">{#each filtered.slice(0,limit) as card (card.id)}<article class="insight-card"><h3>{card.title}</h3>{@render finding(card)}</article>{/each}</div>
   {#if filtered.length>limit}<button class="outline more" onclick={()=>limit=filtered.length}>Показать все ({filtered.length})</button>{/if}
  {/if}
 </div>{/if}
</section>
<style>
.insights-section{margin-bottom:20px}.insights-section header{gap:12px;align-items:center;flex-wrap:wrap}.insights-section header>h2{width:100%;margin:0}.insight-body{padding:14px 16px}.insight-filters{display:flex;gap:4px;flex-wrap:nowrap;overflow-x:auto;margin-bottom:12px;padding:3px;border:1px solid var(--border);border-radius:9px}.insight-filters button{background:transparent;border:0;border-radius:6px;padding:8px 6px;min-height:44px;font-size:13px;color:var(--muted);white-space:nowrap}.insight-filters button.active{color:var(--accent);background:var(--surface)}.insight-filters span{opacity:.7;margin-left:5px}.insight-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:0;padding:0;align-items:start}.insight-card{display:block;min-width:0;padding:12px 0;border:0;border-top:1px solid var(--border);border-radius:0;background:transparent;overflow-wrap:anywhere}.insight-card h3{font-size:14px;margin:0 0 4px;line-height:1.4}.insight-card p{font-size:13px;line-height:1.6;margin:4px 0}.insight-card li{margin:6px 0}.evidence{margin-top:8px}.evidence p{font-size:11px;line-height:1.5}.evidence ul{padding-left:16px;margin:6px 0}.insight-person{margin-top:4px}.more{margin-top:12px;width:100%}@media(max-width:650px){.insight-body{padding:10px}.insight-card{padding:10px}}
</style>
