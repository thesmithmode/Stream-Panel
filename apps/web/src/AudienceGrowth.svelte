<script lang="ts">
 import {localDateWindow} from './time-audience';
 import type {ViewerPlatform} from './daily-metrics';
 import {dailyMetrics,type StreamMetric} from './daily-metrics';
 import Help from './Help.svelte';
 import {countAxis,countAxisInset} from './chart-layout';
 let {platform=$bindable<ViewerPlatform>('all'),metric=$bindable<'online'|'active'>('online'),streams,range,loadStreams,from=0,end=Date.now(),timezone='Europe/Moscow',onStream}:{platform?:ViewerPlatform;metric?:'online'|'active';streams:StreamMetric[];range?:{first:number;total:number};loadStreams?:(params:Record<string,number>,signal:AbortSignal)=>Promise<any>;from?:number;end?:number;timezone?:string;onStream:(id:string)=>void}=$props();
 let viewportWidth=$state(0);
 let availableWidth=$state(800),selected=$state(-1),page=$state(0);
 let remote=$state<StreamMetric[]>([]),loading=$state(false),failure=$state('');
 const points=$derived(dailyMetrics(page>0?remote:streams,timezone,platform));
 const dateKey=(at:number)=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
 const lastDay=$derived(dateKey(end-1));
 const firstDay=$derived(dateKey(Math.max(from,range?.first??streams.reduce((first,s)=>Math.min(first,s.startedAt),end-1))));
 const utcDay=(date:string)=>Date.parse(`${date}T00:00:00Z`);
 const span=$derived(Math.max(1,Math.round((utcDay(lastDay)-utcDay(firstDay))/86400000)+1));
 const pageCount=$derived(Math.ceil(span/30));
 $effect(()=>{void from;void lastDay;void timezone;void firstDay;page=0;});
 const dates=$derived(Array.from({length:Math.min(30,Math.max(0,span-page*30))},(_,i)=>new Date(utcDay(lastDay)-(page*30+Math.min(30,span-page*30)-1-i)*86400000).toISOString().slice(0,10)));
 const displayed=$derived(dates.map(date=>({date,point:points.find(p=>p.date===date)})));
 const keys=$derived(dates.join('|'));
 $effect(()=>{const currentPage=page,currentKeys=keys,loader=loadStreams,tz=timezone;void currentKeys;if(!currentPage||!loader){remote=[];loading=false;failure='';return;}
  const controller=new AbortController();loading=true;failure='';
  const from=localDateWindow(dates[0]!,tz).from,to=localDateWindow(dates.at(-1)!,tz).to;
  void loader({streamFrom:from,streamTo:to},controller.signal).then(result=>{if(!controller.signal.aborted)remote=result.streamComparison??[];}).catch(e=>{if(!controller.signal.aborted)failure=e.message;}).finally(()=>{if(!controller.signal.aborted)loading=false;});
  return()=>controller.abort();
 });
 $effect(()=>{void keys;selected=displayed.findLastIndex(row=>!!row.point);});
 const current=$derived(displayed[selected]);
 const dateTicks=$derived(Array.from({length:Math.min(5,displayed.length)},(_,i)=>Math.round(i*(displayed.length-1)/Math.max(1,Math.min(5,displayed.length)-1))));
 const value=(row:typeof displayed[number])=>row.point?.[metric]??null;
 const axis=$derived(countAxis(Math.max(0,...displayed.map(row=>value(row)??0))));
 const maximum=$derived(axis.maximum),ticks=$derived(axis.ticks);
 const width=$derived(Math.max(280,availableWidth)),plotLeft=$derived(countAxisInset(maximum,36));
 const barStep=$derived((width-plotLeft-12)/Math.max(1,displayed.length));
 const x=(i:number)=>plotLeft+barStep*(i+.5);
 const plotHeight=$derived(viewportWidth>720?270:190);
 const baseline=$derived(plotHeight-40);
 const barWidth=$derived(Math.min(24,barStep*.62));
 const y=(value:number)=>baseline-value/maximum*(baseline-22);
 const shortDate=(date:string)=>`${date.slice(8)}.${date.slice(5,7)}`;
 const fullDate=(date:string)=>`${shortDate(date)}.${date.slice(0,4)}`;
 const format=(value:number|null)=>value===null?'нет данных':value.toLocaleString('ru-RU',{maximumFractionDigits:2});
 const label=$derived(metric==='online'?'Средний онлайн':'Сообщения в час');
 const color=$derived(metric==='active'?'var(--accent)':platform==='twitch'?'var(--twitch,#a970ff)':platform==='youtube'?'var(--youtube,#ff5959)':'var(--teal)');
 const title=(row:typeof displayed[number])=>`${fullDate(row.date)} · ${label}: ${format(value(row))}${row.point?.partial&&metric==='online'?' · неполные данные площадок':''}`;
</script>
<svelte:window bind:innerWidth={viewportWidth}/>
<section class="panel chart-panel audience-growth">
 <header><h2>Динамика по дням</h2><Help id="daily-growth" label="О средних по дням" text="Онлайн усредняется по минутам с замерами. Сообщения в час — число сообщений, делённое на часы эфира: показывает интенсивность чата, а не качество стрима или оптимальную длительность. Эфир относится к дате начала; несколько эфиров за день объединяются с учётом длительности. Пропущенные замеры не считаются нулём. Вместе — сумма известных значений площадок."/></header>
 <div class="stream-chart-toolbar daily-chart-toolbar">
 <select aria-label="Показатель динамики" bind:value={metric}><option value="online">Средний онлайн</option><option value="active">Сообщения в час</option></select>
 {#if metric==='online'}<select aria-label="Источник динамики" bind:value={platform}><option value="all">Вместе</option><option value="twitch">Twitch</option><option value="youtube">YouTube</option></select>{/if}
 </div>
 {#if !(range?.total??streams.length)}<p class="growth-caption muted">Нужны собранные эфиры.</p>{:else}
 <div class="growth-range"><button class="text-button" aria-label="Предыдущие дни" disabled={page+1>=pageCount} onclick={()=>page++}>‹</button><span>{shortDate(dates[0]!)}–{shortDate(dates.at(-1)!)}{metric==='active'?' · сообщений/ч':''}</span><button class="text-button" aria-label="Следующие дни" disabled={page===0} onclick={()=>page--}>›</button></div>
 <div class="growth-plot" bind:clientWidth={availableWidth} aria-busy={loading}>
 {#if loading}<p class="growth-status muted" role="status">Загрузка дней…</p>{:else if failure}<p class="growth-status" role="alert">{failure}</p>{/if}
 <svg viewBox={`0 0 ${width} ${plotHeight}`} height={plotHeight} role="group" aria-label={`${label} по дням`}>
 {#each ticks as tick}<line x1={plotLeft} x2={width-12} y1={y(tick)} y2={y(tick)} stroke="currentColor" opacity=".12"/><text x="1" y={y(tick)-6} fill="currentColor" font-size="10">{format(tick)}</text>{/each}
 {#each displayed as row,i}<g role="button" tabindex="0" data-missing={value(row)===null} aria-label={title(row)} aria-pressed={selected===i} onclick={()=>selected=i} onkeydown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selected=i;}}}>
 {#if value(row)!==null}<rect class="daily-bar" x={x(i)-barWidth/2} y={y(value(row)!)} width={barWidth} height={Math.max(1,baseline-y(value(row)!))} rx="2" fill={color} opacity={selected===i?1:.7}/>{:else}<line x1={x(i)-2} x2={x(i)+2} y1={baseline} y2={baseline} stroke="var(--muted)"/>{/if}
 <rect x={plotLeft+i*barStep} y="16" width={barStep} height={baseline-12} fill="transparent"><title>{title(row)}</title></rect>
 </g>{#if dateTicks.includes(i)}<text x={x(i)} y={baseline+28} text-anchor={i===0?'start':i===displayed.length-1?'end':'middle'} fill="currentColor" font-size="10">{shortDate(row.date)}</text>{/if}{/each}
 </svg></div>
 {#if current}<div class="growth-selection" role="status"><div class="growth-selection-head"><strong>{fullDate(current.date)}</strong><span style:color={color}>{label}: <b>{format(value(current))}</b></span></div>
 {#if current.point?.partial&&metric==='online'}<small>Неполные данные площадок</small>{/if}
 {#each current.point?.streams??[] as stream}<button class="growth-stream text-button" disabled={!stream.id} onclick={()=>{if(stream.id)onStream(stream.id);}}><span>{new Date(stream.startedAt).toLocaleTimeString('ru-RU',{timeZone:timezone,hour:'2-digit',minute:'2-digit'})} · {stream.categories?.join(' · ')||'Без категории'}</span><span>Открыть эфир ›</span></button>{/each}
 </div>{/if}
 {/if}
</section>
<style>
 .daily-chart-toolbar{margin:0 0 8px;gap:8px}.daily-chart-toolbar select{flex:1;max-width:none}.growth-range{display:grid;grid-template-columns:44px minmax(0,1fr) 44px;align-items:center;text-align:center;margin:0;color:var(--muted);font-size:12px}.growth-range button{min-height:44px;font-size:22px}.growth-plot{position:relative;min-width:0;padding:8px 16px}.growth-status{position:absolute;top:8px;left:16px;right:16px;margin:0;padding:6px;background:var(--panel,var(--bg));font-size:12px;z-index:1}svg{width:100%;display:block;}g{cursor:pointer}g:focus{outline:2px solid var(--accent)}.growth-caption{padding:12px 16px;margin:0}.growth-selection{margin:0 16px;padding:8px 0 0}.growth-selection-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:8px;font-size:13px}.growth-selection small{display:block;font-size:11px;color:var(--muted);margin-top:6px}.growth-stream{display:flex;justify-content:space-between;align-items:center;gap:12px;width:100%;min-height:44px;text-align:left;border-top:1px solid var(--border);margin-top:8px;font-size:12px}.growth-stream span:first-child{min-width:0;overflow-wrap:anywhere}.growth-stream span:last-child{white-space:nowrap}
</style>
