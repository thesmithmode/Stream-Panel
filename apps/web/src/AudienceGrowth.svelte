<script lang="ts">
 import type {Snippet} from 'svelte';
 import {audienceGrowth,growthPath,type GrowthStream,type ViewerPlatform} from './audience-growth';
 let {categoryFilter,streams,end=Date.now(),timezone='Europe/Moscow',onStream}:{categoryFilter:Snippet<[string]>;streams:GrowthStream[];end?:number;timezone?:string;onStream:(id:string)=>void}=$props();
 let platform=$state<ViewerPlatform>('all'),availableWidth=$state(800),selected=$state(0);
 const points=$derived(audienceGrowth(streams,platform));
 const start=$derived(end-30*86400000);
 const displayed=$derived(points.filter(p=>p.startedAt>=start&&p.startedAt<end));
 const displayedKeys=$derived(displayed.map(s=>`${s.id??''}:${s.startedAt}`).join('|'));
 $effect(()=>{void displayedKeys;selected=displayed.length-1;});
 const current=$derived(displayed[selected]);
 const maximum=$derived(Math.max(1,...displayed.flatMap(p=>[p.value??0,p.trend??0,p.trend30??0])));
 const width=$derived(Math.max(300,availableWidth));
 const dateX=(at:number)=>36+(at-start)/(end-start)*(width-56);
 const x=(index:number)=>dateX(displayed[index]!.startedAt);
 const y=(value:number)=>174-value/maximum*144;
 const dateLabel=(at:number)=>new Date(at).toLocaleDateString('ru-RU',{timeZone:timezone,day:'2-digit',month:'2-digit'});
 const fullDate=(at:number)=>new Date(at).toLocaleDateString('ru-RU',{timeZone:timezone});
 const timeLabel=(at:number)=>new Date(at).toLocaleTimeString('ru-RU',{timeZone:timezone,hour:'2-digit',minute:'2-digit'});
 const format=(value:number|null)=>value===null?'нет данных':value.toLocaleString('ru-RU',{maximumFractionDigits:2});
 const title=(p:typeof points[number])=>`${fullDate(p.startedAt)}, ${timeLabel(p.startedAt)} · ${p.categories?.join(', ')||'Без категории'} · средние зрители: ${format(p.value)} · среднее за 7 дней: ${format(p.trend)} · среднее за 30 дней: ${format(p.trend30)}`;
 const path=(key:'value'|'trend'|'trend30')=>growthPath(displayed.map((p,i)=>({x:x(i),y:p[key]===null?null:y(p[key])})));
 const ticks=$derived([0,5,10,15,20,25,30].map(days=>start+days*86400000));
 const color=$derived(platform==='twitch'?'var(--twitch,#a970ff)':platform==='youtube'?'var(--youtube,#ff5959)':'var(--teal)');
</script>
<section class="panel audience-growth">
 <header><h2>Динамика аудитории</h2><span class="muted growth-scope">30 дней</span></header>{@render categoryFilter("Категория динамики")}
 <div class="growth-controls" role="group" aria-label="Источник динамики">{#each [['all','Вместе'],['twitch','Twitch'],['youtube','YouTube']] as [value,label]}<button class:active={platform===value} aria-pressed={platform===value} onclick={()=>platform=value as ViewerPlatform}>{label}</button>{/each}</div>
 {#if !displayed.length}<p class="growth-caption muted">Нужны собранные эфиры.</p>{:else}
 <div class="growth-legend"><span style:color={color}>● Средние зрители</span><span class="trend-legend">┄ За 7 дней</span><span class="long-trend-legend">┄ За 30 дней</span></div>
 <div class="growth-plot" bind:clientWidth={availableWidth}><svg viewBox={`0 0 ${width} 210`} role="group" aria-label="Средние зрители и тенденция по эфирам">
  {#each [0,.5,1] as step}<line x1="36" x2={width-20} y1={y(maximum*step)} y2={y(maximum*step)} stroke="currentColor" opacity=".12"/><text x="2" y={y(maximum*step)-6} fill="currentColor" font-size="11">{format(maximum*step)}</text>{/each}
  <path d={path('value')} stroke={color} stroke-width="2.5" fill="none"/><path d={path('trend')} stroke="#e4c568" stroke-width="2" stroke-dasharray="6 3" fill="none"/><path d={path('trend30')} stroke="#b39ddb" stroke-width="2" stroke-dasharray="3 3" fill="none"/>
  {#each displayed as p,i}{#if p.trend!==null}<circle cx={x(i)} cy={y(p.trend)} r="2" fill="#e4c568"/>{/if}<g role="button" tabindex="0" data-missing={p.value===null} aria-label={title(p)} aria-pressed={selected===i} onclick={()=>selected=i} onkeydown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selected=i;}}}>
   {#if p.value===null}<text x={x(i)} y="190" text-anchor="middle" fill="#737c8a" font-size="14">?</text>{:else}<circle pointer-events="none" cx={x(i)} cy={y(p.value)} r={selected===i?6:4} fill={color} stroke={selected===i?'var(--text,#fff)':'none'} stroke-width="2"/>{/if}<rect x={i?(x(i-1)+x(i))/2:Math.max(0,x(i)-13)} y="20" width={Math.max(1,(i+1<displayed.length?(x(i)+x(i+1))/2:x(i)+13)-(i?(x(i-1)+x(i))/2:Math.max(0,x(i)-13)))} height="170" fill="transparent"><title>{title(p)}</title></rect>
  </g>{/each}
  {#each ticks as at,i}<text x={dateX(at)} y="200" text-anchor={i===0?'start':i===ticks.length-1?'end':'middle'} fill="currentColor" font-size="10">{dateLabel(at)}</text>{/each}
 </svg></div>
 {#if current}<div class="growth-selection" role="status"><div class="growth-selection-head"><div><strong>{fullDate(current.startedAt)} · {timeLabel(current.startedAt)}</strong><small>{current.categories?.join(' · ')||'Без категории'}</small></div><button class="outline small" disabled={!current.id} onclick={()=>{if(current.id)onStream(current.id);}}>Открыть эфир</button></div><dl><div><dt>Средние зрители</dt><dd class:no-data={current.value===null} style:color={current.value===null?'var(--muted)':color}>{format(current.value)}</dd></div><div><dt>За 7 дней </dt><dd class="trend-legend" class:no-data={current.trend===null}>{format(current.trend)}</dd></div><div><dt>За 30 дней</dt><dd class="long-trend-legend" class:no-data={current.trend30===null}>{format(current.trend30)}</dd></div></dl></div>{/if}

 <div class="growth-recent" aria-label="Последние эфиры">{#each [...displayed].reverse().slice(0,3) as p}<button disabled={!p.id} onclick={()=>{if(p.id)onStream(p.id);}}><span>{fullDate(p.startedAt)} · {timeLabel(p.startedAt)}<small>{p.categories?.join(' · ')||'Без категории'}</small></span><strong>{format(p.value)}</strong></button>{/each}</div>
 {/if}
</section>
<style>
 .growth-controls{display:flex;gap:4px;margin:14px 16px;padding:4px;background:var(--bg,#0d1118);border-radius:9px}.growth-controls button{flex:1;min-width:0;padding:8px 6px;border:0;background:transparent;color:var(--muted);font-size:13px;border-radius:6px}.growth-controls button.active{background:var(--border,#303743);color:var(--text,#fff)}.growth-legend{display:flex;flex-wrap:wrap;gap:16px;font-size:12px;padding:0 16px}.trend-legend{color:#e4c568}.long-trend-legend{color:#b39ddb}.growth-plot{padding:8px 12px;min-width:0}svg{width:100%;height:auto;display:block;max-height:300px}g{cursor:pointer}g:focus{outline:2px solid var(--accent)}.growth-caption{padding:12px 16px;margin:0}.growth-scope{font-size:12px;font-weight:400}.growth-selection{margin:0 16px;padding:12px;background:var(--bg,#0d1118);border-radius:8px}.growth-selection-head{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:13px}.growth-selection small,.growth-recent small{display:block;color:var(--muted);font-size:12px;margin-top:4px;overflow-wrap:anywhere}.growth-selection dl{display:flex;flex-wrap:wrap;gap:12px 24px;margin:14px 0 0}.growth-selection dt{font-size:11px;color:var(--muted)}.growth-selection dd{margin:4px 0 0;font-size:22px;font-weight:600}.growth-recent{border-top:1px solid var(--border);padding:0 16px}.growth-recent button{display:flex;justify-content:space-between;align-items:center;gap:12px;width:100%;text-align:left;border:0;border-radius:0;border-bottom:1px solid var(--border);background:transparent;padding:10px 0;font-size:13px;color:var(--text,#fff)}.growth-recent button:last-child{border-bottom:0}.growth-recent strong{white-space:nowrap}.growth-recent span{min-width:0}
</style>
