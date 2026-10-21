<script lang="ts">
 import {untrack} from 'svelte';
 import {timeAudience,clockLabel,type TimePerson,type Window,type TimeAudienceSummary} from './time-audience';
 import {platformClass} from './period';
 import Help from './Help.svelte';
 import {ClockVisitors} from './clock-visitors';
 let {scope,revision,windows,people,timezone='Europe/Moscow',onPerson,summary=[],deferredSummary=false,loadVisitors,day='all',resolution=60,selected=null}:{revision?:string|undefined;scope?:string|undefined;windows:Window[];people:TimePerson[];timezone?:string;summary?:TimeAudienceSummary[];deferredSummary?:boolean;loadVisitors?:((params:Record<string,string|number>,signal:AbortSignal)=>Promise<any>)|undefined;onPerson:(id:string)=>void;day?:string;resolution?:number;selected?:number|null}=$props();
 const chosen=$derived.by(()=>{
  if(selected===null)return undefined;
  if(deferredSummary||summary.length)return summary.find(b=>b.day===day&&b.resolution===resolution&&b.minute===selected);
  const b=timeAudience(windows,people,timezone,resolution,day,Math.floor(selected/60)).find(b=>b.minute===selected);
  return b&&b.streams.size?{...b,streams:b.streams.size,people:[...b.people].map(([id,sessions])=>({id,visits:sessions.size})),peopleDeferred:false}:undefined;
 });
 let cache=$state<ClockVisitors|null>(null);
 $effect(()=>{void summary;void people;void scope;void revision;const loader=untrack(()=>loadVisitors);const next=loader?new ClockVisitors(loader):null;cache=next;return ()=>next?.close();});
 $effect(()=>{void selected;void day;void resolution;void scope;visitorPage=null;});
 let visitorOffset=$state(0),visitorPage=$state<any>(null),visitorBusy=$state(false),visitorError=$state('');
 $effect(()=>{void selected;void day;void resolution;void scope;visitorOffset=0;});
 $effect(()=>{
  const bucket=chosen,offset=visitorOffset,loader=cache;visitorError='';visitorBusy=false;
  if(!bucket?.peopleDeferred||!loader)return;
  const controller=new AbortController();visitorBusy=true;
  void loader.page(day,resolution,bucket.minute,offset).then(page=>{if(!controller.signal.aborted)visitorPage=page;}).catch(e=>{if(!controller.signal.aborted)visitorError=e.message;}).finally(()=>{if(!controller.signal.aborted)visitorBusy=false;});
  return ()=>controller.abort();
 });
 const averageLabel=(value:number|null)=>value===null?'нет данных':value.toLocaleString('ru-RU',{maximumFractionDigits:2});
 const byId=$derived(new Map(people.map(p=>[p.id,p])));
 const visitors=$derived(chosen?.peopleDeferred?(visitorPage?.items??[]).map((person:any)=>({person,visits:person.visits,total:chosen.streams})):chosen?chosen.people.map(({id,visits}:{id:string;visits:number})=>({person:byId.get(id),visits,total:chosen.streams})).filter(v=>v.person).sort((a,b)=>b.visits-a.visits||a.person!.name.localeCompare(b.person!.name)):[]);
</script>
{#if selected!==null}
<section class="time-audience" aria-label="Участники выбранного интервала">
 <div class="slot-heading"><h3>Кто бывает в это время</h3><Help id="time-attendance-help" label="О явке по времени" text="Явка = число эфиров с сигналом человека в выбранном интервале / число эфиров, шедших в этом интервале. Повторные сигналы и связанные площадки одного человека учитываются один раз. Активные участники — известные люди по наблюдениям Twitch и сообщениям; это не все зрители. Для YouTube сигнал чата не подтверждает просмотр. Люди показаны за тот же день и интервал, что выбранный столбец."/></div>
 {#if chosen}<p class="slot-caption"><strong>{clockLabel(chosen.minute)}–{clockLabel(chosen.minute+resolution)} · {chosen.streams} стримов · активных участников в среднем {averageLabel(chosen.averageAudience)}</strong></p>
 <div class="table-wrap compact-data"><table><thead><tr><th>Человек</th><th>Явка в это время</th><th>Посещено / шло эфиров</th></tr></thead><tbody>{#each visitors as v (v.person!.id)}<tr><td><button class={`text-button ${platformClass(v.person!.sources??[v.person!.source??''])}`} onclick={()=>onPerson(v.person!.id)}>{v.person!.name}</button></td><td>{Math.round(v.visits/v.total*100)}%</td><td>{v.visits} / {v.total}</td></tr>{/each}</tbody></table></div>
 {#if visitorBusy&&!visitors.length}<p class="empty-small" role="status">Загрузка участников…</p>{:else if visitorError}<p class="empty-small" role="alert">{visitorError}</p>{:else if !visitors.length}<p class="empty-small">Персональных сигналов в этом интервале нет.</p>{/if}
 {#if chosen.peopleDeferred&&visitorPage}<div class="controls"><button class="outline" disabled={visitorBusy||visitorOffset===0} onclick={()=>visitorOffset=Math.max(0,visitorOffset-100)}>Предыдущие в интервале</button><span>Страница {Math.floor(visitorPage.offset/100)+1} · {visitorPage.total} участников</span><button class="outline" disabled={visitorBusy||visitorOffset+100>=visitorPage.total} onclick={()=>visitorOffset+=100}>Следующие в интервале</button></div>{/if}
 {:else}<p class="empty-small">В этом интервале нет записанных эфиров.</p>{/if}
</section>
{/if}
<style>
 .time-audience{border-top:1px solid var(--border)}.slot-heading{display:flex;align-items:center;gap:10px;padding:14px 20px 4px}.slot-heading h3{font-size:14px;margin:0}.slot-caption{padding:8px 20px;font-size:12px}.controls{display:flex;flex-wrap:wrap;gap:12px;padding:16px 20px}.compact-data{max-height:420px;overflow:auto}table{width:100%;border-collapse:collapse}th,td{padding:12px;text-align:left;border-bottom:1px solid var(--border);font-size:12px}td button{white-space:normal;overflow-wrap:anywhere}.twitch{color:var(--twitch,#a970ff)}.youtube{color:var(--youtube,#ff5959)}
</style>
