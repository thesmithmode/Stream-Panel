<script lang="ts">
 import {dateTimeFormatter} from '../../../packages/core/src/date-time-formatter';
 import {api,getServerRevision} from './api';
 import {onMount,untrack} from 'svelte';
 import {subscriberScope,subscriberPeriod,clearSubscriberCache,type SubscriberView as View} from './subscriber-cache';
 import {localDateWindow} from './time-audience';
 import {subscriberPath,subscriberSteps,subscriberValueAt,subscriberStreamBands,subscriberScale,subscriberDateOffsets} from './subscriber-chart';
 import type {Publication} from '../../../packages/core/src/subscriber-history';
 import Help from './Help.svelte';
 let {profile,timezone='Europe/Moscow',onStream}:{profile:string;timezone?:string;onStream:(id:string)=>void}=$props();
 const sources=['twitch','youtube'] as const;
 const name=(source:string)=>source==='twitch'?'Twitch':'YouTube';
 const color=(source:string)=>source==='twitch'?'var(--twitch,#a970ff)':source==='youtube'?'var(--youtube,#ff5959)':'var(--text,#eee)';
 const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 let days=$state(7),day=$state(untrack(today)),ready=$state(false),width=$state(700),loading=$state(false),error=$state('');
 let data=$state<View|null>(null),selection=$state<Publication|null>(null);
 let selectedPoint=$state<{source:string;at:number;total:number}|null>(null),selectedStream=$state<{id:string;start:number;end:number}|null>(null);
 let context='',revision=0;
 let bands=$state<{scope:string;to:number;twitch:View['twitch']['streams'];youtube:View['youtube']['streams']}|null>(null);
 let bandController:AbortController|undefined;
 const bandScope=()=>JSON.stringify([profile,timezone,days,day]);
 async function refreshBands(){
  bandController?.abort();
  const controller=bandController=new AbortController(),scope=bandScope();
  const q=subscriberScope(profile,days,day,timezone),version=getServerRevision(profile,'bands');
  try{
   const reports=await Promise.all(sources.map(source=>api<View['twitch']>(
    `analytics/subscriber-streams?${new URLSearchParams({source,from:String(q.from),to:String(Math.min(q.to,Date.now()))})}`,
    undefined,controller.signal,profile)));
   if(controller.signal.aborted||scope!==bandScope()||version!==getServerRevision(profile,'bands'))return;
   bands={scope,to:reports[0]!.to,twitch:reports[0]!.streams,youtube:reports[1]!.streams};
   const entry=subscriberPeriod(q);
   if(entry.value){
    entry.value={...entry.value,
     twitch:{...entry.value.twitch,streams:reports[0]!.streams,to:reports[0]!.to},
     youtube:{...entry.value.youtube,streams:reports[1]!.streams,to:reports[1]!.to}};
    entry.activityRevision=version;
   }
  }catch{/* Keep the last bands on temporary network loss. */}
 }

 const window=$derived.by(()=>{const end=localDateWindow(day,timezone).to;return {from:localDateWindow(new Date(Date.parse(day)-86400000*(days-1)).toISOString().slice(0,10),timezone).from,to:end};});
 const view=$derived(data??{...window,day,days,timezone});
 const plotWidth=$derived(Math.max(280,width)),left=38,right=38;
 const plotTo=$derived(bands?.scope===bandScope()?bands.to:data?.twitch.to??window.to);
 const x=(at:number)=>left+(Math.max(view.from,Math.min(plotTo,at))-view.from)/Math.max(1,plotTo-view.from)*(plotWidth-left-right);
 const series=$derived(sources.map(source=>({source,report:data?.[source],points:subscriberSteps(data?.[source].counts??[],data?.[source].follows??[],source,view.from),scale:subscriberScale(data?.[source].counts??[])})));
 const totals=$derived(series.flatMap(s=>s.points.map(p=>p.total)));
 const y=(value:number,source:string)=>{const scale=series.find(s=>s.source===source)!.scale;return 230-(value-scale.low)/Math.max(1,scale.high-scale.low)*200;};
 const dateTicks=$derived(subscriberDateOffsets(view.days).map(offset=>localDateWindow(new Date(Date.parse(view.day)-(view.days-1-offset)*86400000).toISOString().slice(0,10),view.timezone).from));
 const normalNumber=new Intl.NumberFormat('ru-RU',{notation:'standard',maximumFractionDigits:1}),compactNumber=new Intl.NumberFormat('ru-RU',{notation:'compact',maximumFractionDigits:1});
 const axisNumber=(n:number)=>(n>=10000?compactNumber:normalNumber).format(n);
 const youtubePoints=$derived(series[1]!.points);
 const publications=$derived((data?.youtube.publications??[]).filter(item=>subscriberValueAt(youtubePoints,item.publishedAt)!==null));
 const streams=$derived(subscriberStreamBands(bands?.scope===bandScope()?bands.twitch:data?.twitch.streams??[],bands?.scope===bandScope()?bands.youtube:data?.youtube.streams??[],view.from,plotTo));
 const dayFormat=$derived(dateTimeFormatter('ru-RU',{timeZone:view.timezone,day:'2-digit',month:'2-digit'})),hourFormat=$derived(dateTimeFormatter('ru-RU',{timeZone:view.timezone,hour:'2-digit',minute:'2-digit'}));
 const label=(at:number,date=false)=>(date?dayFormat:hourFormat).format(at);
 const dateRange=$derived(`${label(view.from,true)}–${label(view.to-1,true)}`);
 const kind=(item:Publication)=>item.kind==='shorts'?'Shorts':item.kind==='video'?'Видео':'Тип уточняется';
 const shift=(direction:number)=>{day=new Date(Date.parse(day)+direction*days*86400000).toISOString().slice(0,10);};
 function load(refresh=false){
  const currentContext=JSON.stringify([profile,timezone]);
  if(context!==currentContext){data=null;context=currentContext;}
  if(refresh){clearSubscriberCache(profile);bands=null;}

  const current=++revision;
  error='';
  const apply=(result:View)=>{if(data?.days!==result.days||data?.day!==result.day){selection=null;selectedStream=null;selectedPoint=null;}data=result;};
  const entry=subscriberPeriod(subscriberScope(profile,days,day,timezone));
  if(entry.value&&entry.activityRevision!==getServerRevision(profile,'bands'))void refreshBands();
  // A ready period swaps synchronously; an in-flight one keeps the entire previous view.
  loading=!entry.value;
  if(entry.value)apply(entry.value);
  void entry.promise.then(result=>{if(current===revision){apply(result);loading=false;}},e=>{if(current===revision){error=e instanceof Error?e.message:String(e);loading=false;}});
  // Fetch both platforms for the alternate period, sharing any request already in flight.
  void subscriberPeriod(subscriberScope(profile,days===7?30:7,day,timezone)).promise.catch(()=>{});
 }
 $effect(()=>{void profile;void days;void day;void timezone;if(!ready)return;untrack(()=>load());});
 onMount(()=>{ready=true;const refresh=()=>load(true);const updateBands=()=>void refreshBands();globalThis.window.addEventListener('sp:stream-bands-refresh',updateBands);globalThis.window.addEventListener('sp:subscribers-refresh',refresh);return()=>{bandController?.abort();globalThis.window.removeEventListener('sp:stream-bands-refresh',updateBands);revision++;globalThis.window.removeEventListener('sp:subscribers-refresh',refresh);};});
</script>
<section class="panel chart-panel subscriber-growth" aria-busy={loading} style:--subscriber-color="var(--accent)">
 <header><div class="subscriber-heading"><h2>Подписчики</h2><Help id="subscriber-growth" label="О графике подписчиков" text="Левая фиолетовая шкала — Twitch, правая красная — YouTube. Шкалы независимы; сравнивайте значения по цвету площадки. Серые полосы — одновременные эфиры, цветные — эфир только одной площадки. Круг — Shorts, ромб — видео; публикации до первого замера YouTube скрыты. Между замерами показано последнее известное число; до первого замера история неизвестна. YouTube не сообщает точное время каждой подписки; с 1000 подписчиков счётчик округляется."/></div></header>
 <div class="subscriber-controls"><div class="subscriber-switch period-switch" role="group" aria-label="Период подписчиков">{#each [7,30] as n}<button class:active={days===n} aria-pressed={days===n} onclick={()=>days=n}>{n} дней</button>{/each}</div>
 <div class="subscriber-date"><button class="outline" aria-label="Предыдущий период подписчиков" onclick={()=>shift(-1)}>‹</button><label><span aria-hidden="true">{dateRange}</span><input aria-label="Дата подписчиков" type="date" value={day} onchange={e=>{if(e.currentTarget.validity.valid&&e.currentTarget.value)day=e.currentTarget.value;else e.currentTarget.value=day;}} max={today()} required/></label><button class="outline" aria-label="Следующий период подписчиков" disabled={day>=today()} onclick={()=>shift(1)}>›</button></div></div>
 {#if error&&!data}<p class="subscriber-note" role="alert">Не удалось загрузить подписчиков. <button class="text-button" onclick={()=>void load()}>Повторить</button></p>{:else if !data}<p class="subscriber-note">{loading?'Загружаем подписчиков…':'Нет замеров за этот период.'}</p>{:else}
 <div class="subscriber-totals">{#each series as s}<div class="subscriber-total" data-source={s.source} style:--series-color={color(s.source)}><small>{name(s.source)}</small><strong>{s.report?.total?.toLocaleString('ru-RU')??'—'}</strong>{#if s.report?.change!=null}<span class="subscriber-change">{s.report.change>0?'+':''}{s.report.change} за период</span>{/if}</div>{/each}</div>
 <div class="subscriber-plot" bind:clientWidth={width}><svg viewBox={`0 0 ${plotWidth} 270`} role="group" aria-label="Число подписчиков Twitch и YouTube">
 {#each [0,.25,.5,.75,1] as fraction}<line x1={left} x2={plotWidth-right} y1={30+fraction*200} y2={30+fraction*200} stroke="currentColor" opacity=".1"/>{/each}
 {#each series as s}{@const side=s.source==='twitch'?left:plotWidth-right}<g class="subscriber-axis" data-axis={s.source} fill={color(s.source)} stroke={color(s.source)}><line x1={side} x2={side} y1="30" y2="230" stroke-width="1.25"/><text x={side} y="18" text-anchor={s.source==='twitch'?'start':'end'} stroke="none" font-size="10">{name(s.source)}</text>{#each s.scale.ticks as value}<line x1={side} x2={side+(s.source==='twitch'?-4:4)} y1={y(value,s.source)} y2={y(value,s.source)}/><text x={side+(s.source==='twitch'?-7:7)} y={y(value,s.source)+3} text-anchor={s.source==='twitch'?'end':'start'} stroke="none" font-size="10">{axisNumber(value)}</text>{/each}</g>{/each}
 {#if !totals.length}<text x={plotWidth/2} y="130" text-anchor="middle" fill="currentColor" font-size="12">Нет замеров за этот период.</text>{/if}
 {#each streams as stream}<g class="stream-band" data-source={stream.source} role="button" tabindex="0" aria-label={`Эфир ${stream.source==='both'?'Twitch и YouTube':name(stream.source)} ${label(stream.start,true)} ${label(stream.start)}–${label(stream.end)}`} onclick={()=>selectedStream=stream} onkeydown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectedStream=stream;}}}><rect class="stream-fill" x={x(stream.start)} width={Math.max(1,x(stream.end)-x(stream.start))} y="30" height="200" fill={color(stream.source)} opacity=".08"/><line x1={x(stream.start)} x2={x(stream.start)} y1="30" y2="230" stroke={color(stream.source)} opacity=".3"/></g>{/each}
 {#each series as s}<g data-series={s.source}>
 <path class="subscriber-line" d={subscriberPath(s.points,plotTo,x,value=>y(value,s.source))} fill="none" stroke={color(s.source)} stroke-width={s.source==='twitch'?4:2}/>
 {#if s.points.at(-1)}<circle class="subscriber-end" cx={x(plotTo)} cy={y(s.points.at(-1)!.total,s.source)} r="2.5" fill={color(s.source)}/>{/if}
 {#each s.points as point}{#if s.points.length===1}<circle cx={x(point.at)} cy={y(point.total,s.source)} r="2.5" fill={color(s.source)}/>{/if}<circle class="count-marker" cx={x(point.at)} cy={y(point.total,s.source)} r="10" fill="transparent" role="button" tabindex="0" aria-label={`${name(s.source)} · ${point.total} подписчиков · ${label(point.at,true)} ${label(point.at)}`} onclick={()=>{selectedPoint={...point,source:s.source};selection=null;}} onkeydown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectedPoint={...point,source:s.source};selection=null;}}}/>{/each}
 </g>{/each}
 {#each dateTicks as at}<g class="subscriber-date-tick"><line x1={x(at)} x2={x(at)} y1="230" y2="234" stroke="currentColor" opacity=".5"/><text x={x(at)} y="251" text-anchor="middle" fill="currentColor" font-size={width<450?10:11}>{label(at,true)}</text></g>{/each}
 {#each publications as item}{@const markerY=y(subscriberValueAt(youtubePoints,item.publishedAt)!,'youtube')}<g class="publication-marker" data-video-id={item.id} data-kind={item.kind} role="button" tabindex="0" aria-label={`${kind(item)} · ${label(item.publishedAt,true)} ${label(item.publishedAt)}`} onclick={()=>{selection=item;selectedPoint=null;}} onkeydown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selection=item;selectedPoint=null;}}}><title>{kind(item)} · {label(item.publishedAt,true)} {label(item.publishedAt)}</title><rect x={x(item.publishedAt)-10} y={markerY-12} width="20" height="24" fill="transparent"/>{#if item.kind==='video'}<path class="publication-shape" d={`M${x(item.publishedAt)},${markerY-5.4} l5.4,5.4 -5.4,5.4 -5.4,-5.4 Z`} fill={color('youtube')} stroke="var(--panel,var(--bg))" stroke-width="1"/>{:else}<circle class="publication-shape" cx={x(item.publishedAt)} cy={markerY} r="2" fill={item.kind==='unknown'?'var(--panel,var(--bg))':color('youtube')} stroke={color('youtube')} stroke-width="1"/>{/if}</g>{/each}
 </svg></div>
 {#if selectedStream}<div class="subscriber-selection"><span>Эфир {label(selectedStream.start,true)} · {label(selectedStream.start)}–{label(selectedStream.end)}</span><button class="text-button" onclick={()=>{if(selectedStream)onStream(selectedStream.id);}}>Открыть эфир</button></div>{/if}
 {#if selectedPoint}<div class="subscriber-selection"><strong style:color={color(selectedPoint.source)}>{name(selectedPoint.source)} · {selectedPoint.total} подписчиков</strong><span>{label(selectedPoint.at,true)} · {label(selectedPoint.at)}</span>{#if selectedPoint.source==='youtube'}<small>Замер счётчика. Точное время подписки неизвестно.</small>{/if}</div>{/if}
 {#if selection}<div class="subscriber-selection publication-selection"><span>{kind(selection)} · {label(selection.publishedAt,true)} {label(selection.publishedAt)}</span>{#if selection.kind==='video'}<span>{selection.title}</span>{/if}</div>{/if}
 {#if error}<p class="subscriber-refresh-error" role="alert">Не удалось обновить. <button class="text-button" onclick={()=>load()}>Повторить</button></p>{/if}
 <div class="subscriber-legend" style:--subscriber-color={color('youtube')}><span><i class="stream-key"></i>Оба</span><span><i class="circle-key"></i>Shorts</span><span><i class="diamond-key"></i>Видео</span></div>
 {/if}
</section>
<style>
 .subscriber-growth{position:relative;min-width:0;overflow:hidden}.subscriber-refresh-error{position:absolute;bottom:24px;left:12px;right:12px;margin:0;padding:6px;background:var(--panel,var(--bg));font-size:12px}.subscriber-growth>header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:16px;border:0;flex-wrap:wrap}.subscriber-heading{display:flex;align-items:center;gap:6px}.subscriber-heading h2{font-size:16px}.subscriber-switch{display:flex;gap:2px;min-width:0}.subscriber-switch button{flex:1;min-width:0;min-height:40px;border:0;border-radius:6px;background:transparent;color:var(--muted);padding:8px 7px;font-size:12px;white-space:nowrap}.subscriber-switch button.active{background:var(--surface);color:var(--accent)}.subscriber-controls{display:flex;align-items:center;justify-content:space-between;gap:4px 8px;padding:0 16px 8px;flex-wrap:wrap}.period-switch{flex:1 1 120px;max-width:180px}.subscriber-date{display:flex;align-items:center;gap:0;flex:1 1 172px;min-width:0}.subscriber-date>button{width:40px;min-width:40px;height:48px;min-height:48px;font-size:22px;padding:0;border:0;background:transparent}.subscriber-date label{position:relative;display:grid;place-items:center;min-height:48px;min-width:0;flex:1;font-size:12px;white-space:nowrap;color:var(--muted)}.subscriber-date input{position:absolute;inset:0;width:100%;height:100%;opacity:0;min-width:0;padding:0;cursor:pointer}.subscriber-date label:focus-within{outline:2px solid var(--accent);outline-offset:-3px;border-radius:6px}.subscriber-total{display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:4px 12px;font-size:13px;color:var(--muted)}.subscriber-total strong{font-size:28px;color:var(--text)}.subscriber-total small{font-size:12px}.subscriber-plot{padding:0 12px;min-width:0}.subscriber-plot svg{width:100%;height:auto;display:block;color:var(--muted)}.subscriber-plot [role=button]{cursor:pointer}.subscriber-plot [role=button]:focus{outline:2px solid var(--subscriber-color)}.subscriber-note{padding:10px 12px;margin:0;color:var(--muted);font-size:12px;line-height:1.5}.subscriber-legend{display:flex;flex-wrap:nowrap;justify-content:center;gap:12px;padding:0 12px 8px;white-space:nowrap;font-size:10px;color:var(--muted)}.subscriber-legend span{display:flex;align-items:center;gap:6px}.circle-key,.diamond-key{display:inline-block;flex-shrink:0;background:var(--subscriber-color)}.stream-key{width:8px;height:8px;background:var(--text);opacity:.4;border-radius:1px}.circle-key{width:4px;height:4px;border-radius:50%}.diamond-key{width:7px;height:7px;transform:rotate(45deg)}.subscriber-selection{display:flex;flex-wrap:wrap;gap:8px;margin:4px 12px;padding:8px;background:var(--bg);border-radius:6px;font-size:12px}.subscriber-selection small{flex-basis:100%;color:var(--muted)}

.subscriber-totals{display:flex;flex-wrap:wrap;gap:8px 24px;padding:8px 16px}.subscriber-totals .subscriber-total{padding:0;gap:6px;align-items:baseline;color:var(--series-color)}.subscriber-totals .subscriber-total strong{color:var(--series-color);font-size:24px}.subscriber-change{font-size:11px;color:var(--muted)}
@media(max-width:480px){.subscriber-totals{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.subscriber-totals .subscriber-total{gap:4px 6px;min-height:44px;align-content:start}.subscriber-change{flex-basis:100%}}
@media(max-width:380px){.subscriber-controls{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}.period-switch{max-width:none;width:100%}.subscriber-date{width:100%;margin:0}}
</style>
