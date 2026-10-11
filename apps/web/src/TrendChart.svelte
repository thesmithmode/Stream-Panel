<script lang="ts">
  import {chartSeries, type ChartMetric, type ChartPoint} from './chart-series';
  import {chartLayout,chartPages} from './chart-layout';
  import Help from './Help.svelte';
  const id=$props.id();
  import {timelineTicks} from './chart-detail';
  let {points,metric,resolution=0,showRegulars=true,timezone='Europe/Moscow',onselect}:{points:ChartPoint[];metric:ChartMetric;resolution?:number;showRegulars?:boolean;timezone?:string;onselect?:(point:ReturnType<typeof chartSeries>[number])=>void}=$props();
  let availableWidth=$state(800),pageOffset=$state(0);
  const pages=$derived(chartPages(points));
  const visiblePoints=$derived(pages[pageOffset]??[]);
  $effect(()=>{if(pageOffset>=pages.length)pageOffset=0;});
  const layout=$derived(chartLayout(visiblePoints[0]?.at??0,(visiblePoints.at(-1)?.at??0)+60000,availableWidth,resolution));
  const buckets=$derived(chartSeries(visiblePoints,metric,layout.resolution));
  const maximum=$derived(Math.max(1,...buckets.map(p=>p.value)));
  const start=$derived(buckets[0]?.at??0),end=$derived((buckets.at(-1)?.at??0)+(buckets[0]?.width??60000));
  const ticks=$derived(timelineTicks(start,end));
  const plotWidth=$derived(layout.plotWidth);
  const timeLabel=(at:number)=>new Date(at).toLocaleTimeString('ru-RU',{timeZone:timezone,hour:'2-digit',minute:'2-digit'});
  const split=$derived(showRegulars&&!['viewers','twitchViewers','youtubeViewers'].includes(metric));
  const height=(value:number)=>value>0?Math.max(1,value/maximum*160):0;
  function title(point:typeof buckets[number]) {
    const label=`${new Date(point.at).toLocaleString('ru-RU',{timeZone:timezone})} · ${Math.round(point.width/60000)} мин`;
    if(point.isBreak)return `${label} · Перерыв`;
    if(!point.known)return `${label} · нет данных`;
    const regular=split&&point.value>0?` · ядро: ${point.regularValue.toFixed(1)} (${(point.regularValue/point.value*100).toFixed(1)}%)`:'';
    return `${label} · всего: ${point.value.toFixed(1)}${regular}`;
  }
</script>
<div class="trend-chart" bind:clientWidth={availableWidth}>
  {#if !buckets.length}<p class="muted">Пока нет точек для графика</p>{:else}
    {#if split}<div class="legend chart-legend"><span><i class="regular-swatch"></i>Ядро аудитории</span><span><i class="follower-swatch"></i>Подписчики</span><span><i class="other-swatch"></i>Остальные участники</span></div>{/if}
    <div class="trend-plot"><svg viewBox={`0 0 ${plotWidth} 245`} style="width:100%;display:block" role="group" aria-label="График активности по выбранному периоду">
      <line x1="32" y1="190" x2={plotWidth-10} y2="190" stroke="currentColor" opacity=".25" />
      <text x="5" y="24" fill="currentColor" font-size="12">{Math.round(maximum)}</text><text x="8" y="190" fill="currentColor" font-size="12">0</text>
      {#each buckets as p}
        {@const barHeight=height(p.value)}
        {@const regularHeight=p.value>0?barHeight*p.regularValue/p.value:0}
        {@const followerHeight=split&&p.value>0?barHeight*p.followerValue/p.value:0}
        <g class="chart-bar" role="button" tabindex="0" aria-label={title(p)} onclick={()=>onselect?.(p)} onkeydown={(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onselect?.(p);}}}>
          <rect class="total-segment" x={32+(p.at-start)/(end-start)*(plotWidth-50)} y={p.known?190-barHeight:185} width={Math.max(1,p.width/(end-start)*(plotWidth-50)-1)} height={p.known?barHeight:5} class:unknown={!p.known} class:estimated={metric==='estimated'}><title>{title(p)}</title></rect>
          {#if split&&p.known&&regularHeight>0}<rect class="regular-segment" x={32+(p.at-start)/(end-start)*(plotWidth-50)} y={190-regularHeight} width={Math.max(1,p.width/(end-start)*(plotWidth-50)-1)} height={regularHeight}><title>{title(p)}</title></rect>{/if}
          {#if split&&p.known&&followerHeight>0}<rect class="follower-segment" x={32+(p.at-start)/(end-start)*(plotWidth-50)} y={190-regularHeight-followerHeight} width={Math.max(1,p.width/(end-start)*(plotWidth-50)-1)} height={followerHeight}><title>{title(p)}</title></rect>{/if}
          <rect x={32+(p.at-start)/(end-start)*(plotWidth-50)} y="25" width={Math.max(1,p.width/(end-start)*(plotWidth-50))} height="165" fill="transparent" style="pointer-events:all;fill:transparent"><title>{title(p)}</title></rect>
        </g>
      {/each}
      {#each ticks as at,i}
        {@const x=32+(at-start)/(end-start)*(plotWidth-50)}
        <line x1={x} y1="190" x2={x} y2="197" stroke="currentColor" opacity=".4" />
        {#if i%layout.labelEvery===0}<text x={Math.max(38,Math.min(x,plotWidth-38))} y="213" text-anchor="middle" fill="currentColor" font-size="12">{timeLabel(at)}</text>
        <text x={Math.max(38,Math.min(x,plotWidth-38))} y="231" text-anchor="middle" fill="currentColor" font-size="10">{new Date(at).toLocaleDateString('ru-RU',{timeZone:timezone,day:'2-digit',month:'2-digit'})}</text>{/if}
      {/each}
    </svg></div>
    {#if pages.length>1}<div class="chart-pages"><button class="outline small" disabled={pageOffset+1>=pages.length} onclick={()=>pageOffset++}>Раньше</button><span>{new Date(start).toLocaleDateString('ru-RU',{timeZone:timezone})} · {timeLabel(start)}–{timeLabel(end)}</span><button class="outline small" disabled={pageOffset===0} onclick={()=>pageOffset--}>Позже</button></div>{/if}
    <div class="chart-caption"><span>Столбец: {Math.round((buckets[0]?.width??60000)/60000)} мин · {timezone}</span><Help id={`${id}-help`} label="Как читать график" text="Нажмите столбец для детализации. Шкала — каждые 15 минут; для периодов длиннее суток шаг укрупняется. Столбцы не длиннее пяти минут; длинный период листается блоками; внутри выбранного столбца можно выбрать отдельную минуту. Для участников высота — среднее по известным сигналам, для сообщений — сумма. Жёлтый сегмент — ядро аудитории. Серые отметки — нет данных."/></div>
  {/if}
</div>

<style>
  .chart-pages{display:flex;align-items:center;gap:12px;justify-content:center;flex-wrap:wrap;font-size:12px;}
  .chart-caption{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);margin-top:8px;}
  .trend-chart{width:100%;min-width:0;}
  .trend-plot{width:100%;min-width:0;}
  svg{overflow:hidden;height:auto;}
  .chart-bar{cursor:pointer;}
  .chart-bar:focus{outline:2px solid currentColor;}
</style>
