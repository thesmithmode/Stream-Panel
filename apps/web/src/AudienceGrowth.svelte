<script lang="ts">
 import {audienceGrowth,type GrowthStream,type ViewerPlatform} from './audience-growth';
 import Help from './Help.svelte';
 let {streams,timezone='Europe/Moscow',onStream}:{streams:GrowthStream[];timezone?:string;onStream:(id:string)=>void}=$props();
 let platform=$state<ViewerPlatform>('all'),page=$state(0),availableWidth=$state(800);
 const points=$derived(audienceGrowth(streams,platform));
 const pages=$derived(Math.max(1,Math.ceil(points.length/50)));
 $effect(()=>{void streams;page=0;});
 const displayed=$derived(points.slice(Math.max(0,points.length-(page+1)*50),points.length-page*50));
 const maximum=$derived(Math.max(1,...displayed.flatMap(p=>[p.value??0,p.trend??0])));
 const width=$derived(Math.max(300,availableWidth)),start=$derived(displayed[0]?.startedAt??0),end=$derived(displayed.at(-1)?.startedAt??start);
 const x=(at:number)=>end===start?width/2:40+(at-start)/(end-start)*(width-60);
 const y=(value:number)=>190-value/maximum*160;
 const dateLabel=(at:number)=>new Date(at).toLocaleDateString('ru-RU',{timeZone:timezone,day:'2-digit',month:'2-digit'});
 const format=(value:number|null)=>value===null?'нет данных':value.toLocaleString('ru-RU',{maximumFractionDigits:2});
 const title=(p:typeof points[number])=>`${new Date(p.startedAt).toLocaleString('ru-RU',{timeZone:timezone})} · ${p.categories?.join(', ')||'Без категории'} · средние зрители: ${format(p.value)} · среднее за 7 эфиров: ${format(p.trend)}`;
 function path(key:'value'|'trend'){
  let open=false;
  return displayed.map(p=>{const value=p[key];if(value===null){open=false;return '';}const part=`${open?'L':'M'}${x(p.startedAt)},${y(value)}`;open=true;return part;}).join(' ');
 }
 const ticks=$derived([...new Set([0,Math.floor((displayed.length-1)/2),displayed.length-1])].filter(i=>i>=0).map(i=>displayed[i]!).filter(Boolean));
 const color=$derived(platform==='twitch'?'var(--twitch,#a970ff)':platform==='youtube'?'var(--youtube,#ff5959)':'var(--teal)');
</script>
<section class="panel audience-growth">
 <header><h2>Динамика аудитории</h2><Help id="audience-growth-help" label="О динамике аудитории" text="Каждая точка — среднее число зрителей одного эфира по известным замерам. Золотая линия — среднее средних за этот и шесть предыдущих эфиров выбранного периода. Она появляется с седьмого эфира; при неизвестном значении в окне линия прерывается. Эфиры в этом сглаживании имеют одинаковый вес независимо от длительности. Пропущенные замеры не заменяются нулём. Нажмите точку, чтобы открыть эфир. Сумма площадок не означает уникальных людей."/></header>
 <div class="growth-controls"><label>Источник динамики<select bind:value={platform}><option value="all">Twitch + YouTube</option><option value="twitch">Twitch</option><option value="youtube">YouTube</option></select></label><div class="growth-legend"><span style:color={color}>● Средние зрители</span><span class="trend-legend">● Среднее за 7 эфиров</span></div></div>
 {#if !displayed.length}<p class="growth-caption muted">Нужны собранные эфиры.</p>{:else}
 <div class="growth-plot" bind:clientWidth={availableWidth}><svg viewBox={`0 0 ${width} 240`} role="group" aria-label="Средние зрители и тенденция по датам эфиров">
  <text x="4" y="20" fill="currentColor" font-size="12">{format(maximum)}</text><text x="12" y="190" fill="currentColor" font-size="12">0</text>
  <line x1="40" x2={width-20} y1="190" y2="190" stroke="currentColor" opacity=".3"/>
  <path d={path('value')} stroke={color} stroke-width="2" fill="none"/><path d={path('trend')} stroke="#e4c568" stroke-width="3" stroke-dasharray="6 3" fill="none"/>
  {#each displayed as p}<g role="button" tabindex={p.id?0:-1} aria-label={title(p)} onclick={()=>{if(p.id)onStream(p.id);}} onkeydown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();if(p.id)onStream(p.id);}}}>
   <circle cx={x(p.startedAt)} cy={p.value===null?190:y(p.value)} r={4} fill={p.value===null?'#737c8a':color}/><circle cx={x(p.startedAt)} cy={p.value===null?190:y(p.value)} r="12" fill="transparent"><title>{title(p)}</title></circle>
  </g>{/each}
  {#each ticks as p,i}<text x={x(p.startedAt)} y="220" text-anchor={i===0?'start':i===ticks.length-1?'end':'middle'} fill="currentColor" font-size="12">{dateLabel(p.startedAt)}</text>{/each}
 </svg></div>
 <p class="growth-caption small muted">Одна точка — один эфир · {timezone}. Нажмите точку, чтобы открыть эфир.{#if points.length<7} Для линии тенденции нужно 7 эфиров.{/if}</p>
 {#if pages>1}<div class="growth-pages"><button class="outline small" disabled={page+1>=pages} onclick={()=>page++}>Раньше</button><span>{page+1} / {pages}</span><button class="outline small" disabled={page===0} onclick={()=>page--}>Позже</button></div>{/if}
 <details class="growth-details"><summary>Даты, категории и значения</summary><div class="table-wrap"><table><thead><tr><th>Эфир</th><th>Средние зрители</th><th>За 7 эфиров</th></tr></thead><tbody>{#each displayed as p}<tr><td><button class="text-button" disabled={!p.id} onclick={()=>{if(p.id)onStream(p.id);}}>{new Date(p.startedAt).toLocaleString('ru-RU',{timeZone:timezone})}</button><small>{p.categories?.join(', ')||'Без категории'}</small></td><td>{format(p.value)}</td><td>{format(p.trend)}</td></tr>{/each}</tbody></table></div></details>
 {/if}
</section>
<style>
 .growth-controls{display:flex;flex-wrap:wrap;gap:12px;padding:12px 16px;align-items:center}.growth-controls label{display:grid;gap:6px;font-size:12px;flex:1 1 180px}select{width:100%;min-width:0}.growth-legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px}.trend-legend{color:#e4c568}.growth-plot{padding:8px 12px;min-width:0}svg{width:100%;height:auto;display:block}g{cursor:pointer}g:focus{outline:2px solid var(--accent)}.growth-caption{padding:0 16px 12px;margin:0}.growth-pages{display:flex;justify-content:center;align-items:center;gap:12px;padding:12px}.growth-details summary{padding:12px 16px;cursor:pointer}.growth-details table{width:100%;border-collapse:collapse;font-size:12px}.growth-details td,.growth-details th{padding:10px;text-align:left;border-bottom:1px solid var(--border)}.growth-details small{display:block;color:var(--muted)}.growth-details button{white-space:normal;text-align:left}
</style>
