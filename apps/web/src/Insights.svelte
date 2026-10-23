<script lang="ts">
 import {untrack} from 'svelte';
 import Icon from './Icon.svelte';
 const disclosureId=$props.id();
 import {api,date,type InsightCard} from './api';
 import {ConnectionError} from './request';
 let {report,sessionId='',refreshToken,loading=false,onPerson,onStream}:{report?:any;sessionId?:string;refreshToken?:unknown;loading?:boolean;onPerson:(id:string)=>void;onStream?:(id:string)=>void}=$props();
 const groups=[{id:'all',label:'Все'},{id:'schedule',label:'Расписание'},{id:'people',label:'Люди'},{id:'content',label:'Контент'},{id:'support',label:'Поддержка'},{id:'stream',label:'Эфиры'}];
 let opened=$state(false),local=$state<any>(null),busy=$state(false),error=$state(''),group=$state('all'),limit=$state(12),retry=$state(0),peopleLimits=$state<Record<string,number>>({});
 const data=$derived(report??local),cards=$derived((data?.insights??[]) as InsightCard[]),filtered=$derived(cards.filter(c=>group==='all'||c.group===group));
 const bundles=$derived.by(()=>{const result=new Map<string,{id:string;items:InsightCard[]}>();for(const card of filtered){const key=card.personId?`${card.kind}:${card.group}`:card.id;const row=result.get(key)??{id:key,items:[]};row.items.push(card);result.set(key,row);}return [...result.values()].sort((a,b)=>Number(b.items[0]!.group==='schedule')-Number(a.items[0]!.group==='schedule'));});
 const countFindings=(topic:string)=>new Set(cards.filter(c=>topic==='all'||c.group===topic).map(c=>c.personId?`${c.kind}:${c.group}`:c.id)).size;
 const bundleTitle=(card:InsightCard,n:number)=>({silent_regular:card.group==='support'?`Молчаливые участники поддерживают канал · ${n}`:`Молчаливое ядро · ${n} участников`,person_schedule:`Привычное время участников · ${n} закономерностей`,person_category:`Предпочтения по категориям · ${n} закономерностей`,missing_regular:`Перестали появляться · ${n} участников`,became_silent:`Продолжают присутствовать, но перестали писать · ${n}`,return_after_gap:`Вернулись после перерыва · ${n}`,chat_regular:`Поддерживают разговор · ${n}`,repeat_support:`Повторная поддержка · ${n}`} as Record<string,string>)[card.kind]??card.title;
 $effect(()=>{void group;void sessionId;void report;limit=12;});
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
 <div class="evidence"><p class="small muted">{card.basis}</p>{#if card.action}<p class="small">{card.action}</p>{/if}<ul>{#each card.evidence.slice(0,3) as item}<li>{#if onStream}<button class="text-button small" onclick={()=>onStream?.(item.sessionId)}>{date(item.at)} · {item.label}</button>{:else}<span class="small">{date(item.at)} · {item.label}</span>{/if}</li>{/each}</ul></div>
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
   <div class="insight-grid">{#each bundles.slice(0,limit) as bundle (bundle.id)}{@const card=bundle.items[0]!}<article class="insight-card">
    {#if bundle.items.length===1}<h3>{card.title}</h3>{@render finding(card)}
    {:else}<h3>{bundleTitle(card,bundle.items.length)}</h3>
     <div class="finding-list">
      {#each bundle.items.slice(0,peopleLimits[bundle.id]??3) as item (item.id)}<details class="person-finding"><summary>{item.personName??item.title}<span>{item.sampleSize} наблюдений</span></summary>{@render finding(item)}</details>{/each}
      {#if bundle.items.length>(peopleLimits[bundle.id]??3)}<button class="text-button small" onclick={()=>peopleLimits={...peopleLimits,[bundle.id]:(peopleLimits[bundle.id]??3)+3}}>Ещё участники · осталось {bundle.items.length-(peopleLimits[bundle.id]??3)}</button>{/if}
     </div>
    {/if}
   </article>{/each}</div>
   {#if bundles.length>limit}<button class="outline more" onclick={()=>limit+=12}>Показать ещё · осталось {bundles.length-limit}</button>{/if}
  {/if}
 </div>{/if}
</section>
<style>
.insights-section{margin-bottom:20px}.insights-section header{gap:12px;align-items:center;flex-wrap:wrap}.insights-section header>h2{width:100%;margin:0}.insight-body{padding:14px 16px}.insight-filters{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:12px}.insight-filters button{background:transparent;border:1px solid var(--border);border-radius:999px;padding:6px 9px;font-size:11px;color:var(--muted)}.insight-filters button.active{border-color:var(--accent,#bba3ff);color:var(--text,#eee);background:#a78bfa15}.insight-filters span{opacity:.7;margin-left:5px}.insight-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;padding:0;align-items:start}.insight-card{display:block;min-width:0;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--bg);overflow-wrap:anywhere}.insight-card h3{font-size:14px;margin:0 0 4px;line-height:1.4}.insight-card p{font-size:13px;line-height:1.6;margin:4px 0}.insight-card li{margin:6px 0}.finding-list{margin:4px 0 0;padding-left:10px;border-left:2px solid var(--border)}.person-finding{padding:0;margin:4px 0 0}.person-finding>summary{display:flex;justify-content:space-between;gap:8px;min-height:40px;margin:0;align-items:center;padding:4px 6px;font-size:12px;background:transparent;cursor:pointer;color:var(--text);font-weight:600}.person-finding>summary span{font-weight:400;font-size:11px;color:var(--muted);flex-shrink:0}.person-finding[open]{padding:0 6px 8px;background:var(--panel,var(--bg));border-radius:6px}.person-finding[open]>summary{margin-bottom:6px}.evidence{border-left:2px solid var(--border);padding-left:10px;margin-top:8px}.evidence p{font-size:11px;line-height:1.5}.evidence ul{padding-left:16px;margin:6px 0;max-height:120px;overflow:auto}.insight-person{margin-top:4px}.more{margin-top:12px;width:100%}@media(max-width:650px){.insight-body{padding:10px}.insight-card{padding:10px}}
</style>
