<script lang="ts">
  import {num} from './format';
  import {chartSeries,isMessageMetric, type ChartMetric, type ChartPoint} from './chart-series';
  import {chartLayout,chartPages,countAxis,countAxisInset} from './chart-layout';
  import Help from './Help.svelte';
  const id=$props.id();
  import {timelineTicks} from './chart-detail';
  let {points,metric,resolution=1,showRegulars=true,timezone='Europe/Moscow',selectedAt=null,onselect}:{points:ChartPoint[];metric:ChartMetric;resolution?:number;showRegulars?:boolean;timezone?:string;selectedAt?:number|null;onselect?:(point:ReturnType<typeof chartSeries>[number])=>void}=$props();
  let availableWidth=$state(800),pageOffset=$state(0),focusedAt=$state<number|null>(null);
  const pages=$derived(chartPages(points,resolution));
  const visiblePoints=$derived(pages[pageOffset]??[]);
  $effect(()=>{if(pageOffset>=pages.length)pageOffset=0;});
  const layout=$derived(chartLayout(visiblePoints[0]?.at??0,(visiblePoints.at(-1)?.at??0)+60000,availableWidth,resolution));
  const buckets=$derived(chartSeries(visiblePoints,metric,layout.resolution));
  const axis=$derived(countAxis(Math.max(0,...buckets.map(p=>p.value))));
  const maximum=$derived(axis.maximum);
  const plotLeft=$derived(countAxisInset(maximum));
  const start=$derived(visiblePoints[0]?.at??0),end=$derived((visiblePoints.at(-1)?.at??0)+60000);
  const ticks=$derived(timelineTicks(start,end));
  const plotWidth=$derived(layout.plotWidth);
  const timeFormatter=$derived(new Intl.DateTimeFormat('ru-RU',{timeZone:timezone,hour:'2-digit',minute:'2-digit'}));
  const dateFormatter=$derived(new Intl.DateTimeFormat('ru-RU',{timeZone:timezone,day:'2-digit',month:'2-digit'}));
  const crossesDay=$derived(dateFormatter.format(start)!==dateFormatter.format(end));
  const detailFormatter=$derived(new Intl.DateTimeFormat('ru-RU',{timeZone:timezone,dateStyle:'short',timeStyle:'medium'}));
  const timeLabel=(at:number)=>timeFormatter.format(at);
  const split=$derived(showRegulars&&!['viewers','twitchViewers','youtubeViewers'].includes(metric));
  const hasUnknown=$derived(buckets.some(p=>(p.unknownValue??0)>0));
  const height=(value:number)=>value>0?Math.max(1,value/maximum*220):0;
  function title(point:typeof buckets[number]) {
    const label=`${detailFormatter.format(point.at)} · ${Math.round(point.width/60000)} мин`;
    if(point.isBreak)return `${label} · Перерыв`;
    if(!point.known)return `${label} · нет данных`;
    const partial=point.partial?' · неполные замеры площадок':'';
    const regular=split&&point.value>0?` · ядро: ${num(point.regularValue)} (${num((point.regularValue/point.value*100))}%)`:'';
    const groups=split?` · подписчики: ${num(point.followerValue)} · залётные: ${num(Math.max(0,point.value-point.regularValue-point.followerValue-(point.unknownValue??0)))}${hasUnknown?` · статус неизвестен: ${num((point.unknownValue??0))}`:''}`:'';
    return `${label} · всего: ${num(point.value)}${regular}${groups}${partial}`;
  }
  const titles=$derived(new Map(buckets.map(point=>[point.at,title(point)])));
  const highlighted=$derived(buckets.find(point=>point.at===(focusedAt??selectedAt)));
</script>
<div class="trend-chart" bind:clientWidth={availableWidth}>
  {#if !buckets.length}<p class="muted">Пока нет точек для графика</p>{:else}
    {#if split}<div class="legend chart-legend"><span><i class="regular-swatch"></i>Ядро аудитории</span><span><i class="follower-swatch"></i>Подписчики</span><span><i class="other-swatch"></i>{isMessageMetric(metric)?'Залётные':'Остальные участники'}</span>{#if hasUnknown}<span><i class="unknown-swatch"></i>Статус подписки неизвестен</span>{/if}</div>{/if}

    <div class="trend-plot"><svg viewBox={`0 0 ${plotWidth} 305`} style="width:100%;display:block" role="group" aria-label="График активности по выбранному периоду">
      <defs><clipPath id={`${id}-plot`}><rect x={plotLeft} y="25" width={plotWidth-plotLeft-24} height="225"/></clipPath></defs>
      {#each axis.ticks as tick}
        {@const y=250-tick/maximum*220}
        <line x1={plotLeft} y1={y} x2={plotWidth-24} y2={y} stroke="currentColor" opacity={tick===0?'.25':'.12'} />
        <text class="count-axis-tick" x={plotLeft-6} y={y+4} text-anchor="end" fill="currentColor" font-size="12">{num(tick,0)}</text>
      {/each}
      <g clip-path={`url(#${id}-plot)`}>
      {#each buckets as p}
        {@const barHeight=height(p.value)}
        {@const regularHeight=p.value>0?barHeight*p.regularValue/p.value:0}
        {@const followerHeight=split&&p.value>0?barHeight*p.followerValue/p.value:0}
        {@const unknownHeight=split&&p.value>0?barHeight*(p.unknownValue??0)/p.value:0}
        <g class="chart-bar" role="button" tabindex="0" aria-label={titles.get(p.at)} aria-pressed={selectedAt===p.at} onfocus={()=>focusedAt=p.at} onblur={()=>focusedAt=null} onclick={()=>onselect?.(p)} onkeydown={(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onselect?.(p);}}}>
          <rect class="total-segment" x={plotLeft+(p.at-start)/(end-start)*(plotWidth-plotLeft-24)} y={p.known?250-barHeight:245} width={Math.max(.2,p.width/(end-start)*(plotWidth-plotLeft-24)*.9)} height={p.known?barHeight:5} class:unknown={!p.known} class:estimated={metric==='estimated'}><title>{titles.get(p.at)}</title></rect>
          {#if split&&p.known&&regularHeight>0}<rect class="regular-segment" x={plotLeft+(p.at-start)/(end-start)*(plotWidth-plotLeft-24)} y={250-regularHeight} width={Math.max(.2,p.width/(end-start)*(plotWidth-plotLeft-24)*.9)} height={regularHeight}><title>{titles.get(p.at)}</title></rect>{/if}
          {#if split&&p.known&&followerHeight>0}<rect class="follower-segment" x={plotLeft+(p.at-start)/(end-start)*(plotWidth-plotLeft-24)} y={250-regularHeight-followerHeight} width={Math.max(.2,p.width/(end-start)*(plotWidth-plotLeft-24)*.9)} height={followerHeight}><title>{titles.get(p.at)}</title></rect>{/if}
          {#if split&&p.known&&unknownHeight>0}<rect class="unknown-segment" x={plotLeft+(p.at-start)/(end-start)*(plotWidth-plotLeft-24)} y={250-regularHeight-followerHeight-unknownHeight} width={Math.max(.2,p.width/(end-start)*(plotWidth-plotLeft-24)*.9)} height={unknownHeight}><title>{titles.get(p.at)}</title></rect>{/if}
          <rect x={plotLeft+(p.at-start)/(end-start)*(plotWidth-plotLeft-24)} y="25" width={Math.max(1,p.width/(end-start)*(plotWidth-plotLeft-24))} height="225" fill="transparent" style="pointer-events:all;fill:transparent"><title>{titles.get(p.at)}</title></rect>
        </g>
      {/each}
      </g>
      {#if highlighted}
        <!-- Paint above all bars and outside their clip; CSS outlines on SVG groups are clipped. -->
        <rect class="bar-highlight" x={plotLeft+(Math.max(start,highlighted.at)-start)/(end-start)*(plotWidth-plotLeft-24)+1} y="26" width={Math.max(1,(Math.min(end,highlighted.at+highlighted.width)-Math.max(start,highlighted.at))/(end-start)*(plotWidth-plotLeft-24)-2)} height="223" aria-hidden="true"/>
      {/if}
      {#each ticks as at,i}
        {@const x=plotLeft+(at-start)/(end-start)*(plotWidth-plotLeft-24)}
        <line x1={x} y1="250" x2={x} y2="257" stroke="currentColor" opacity=".4" />
        {#if i%layout.labelEvery===0}<text x={x} y="273" text-anchor="middle" fill="currentColor" font-size="12">{timeLabel(at)}</text>
        {#if crossesDay}<text x={x} y="291" text-anchor="middle" fill="currentColor" font-size="10">{dateFormatter.format(at)}</text>{/if}{/if}
      {/each}
    </svg></div>
    {#if pages.length>1}<div class="chart-pages"><button class="outline small" disabled={pageOffset+1>=pages.length} onclick={()=>pageOffset++}>Раньше</button><span>{new Date(start).toLocaleDateString('ru-RU',{timeZone:timezone})} · {timeLabel(start)}–{timeLabel(end)}</span><button class="outline small" disabled={pageOffset===0} onclick={()=>pageOffset--}>Позже</button></div>{/if}
    <div class="chart-caption"><Help id={`${id}-help`} label="Как читать график" text={`Столбец: ${Math.round((buckets[0]?.width??60000)/60000)} мин · ${timezone}. Площадки не раскрывают состав всех зрителей. Разделение на группы доступно для сообщений. Нажмите столбец для детализации. Шкала — каждые 15 минут; для периодов длиннее суток шаг укрупняется. Интервал столбца выбирается: 1, 5 или 15 минут; длинный период листается блоками; внутри выбранного столбца можно выбрать отдельную минуту. Для зрителей высота — среднее по известным замерам, для сообщений — сумма. Ядро имеет приоритет над подпиской; залётные — авторы с подтверждённым отсутствием подписки, неизвестный статус показан отдельно. Зрители (все) — сумма средних замеров Twitch и YouTube; неполные замеры отмечены в детализации. Жёлтый сегмент — ядро аудитории. Серые отметки — нет данных.`}/></div>
  {/if}
</div>

<style>
  .trend-chart{position:relative;width:100%;min-width:0;padding:16px 20px;}
  :global(.stream-page) .trend-chart{padding:4px 0 12px;}
  .trend-plot{width:100%;min-width:0;}
  svg{display:block;width:100%;min-width:0;max-height:280px;overflow:hidden;height:auto;}
  .total-segment{fill:#5fc4aa;}
  .total-segment.unknown{fill:#606d7d;}
  .total-segment.estimated{fill:#ac89ec;}
  .regular-segment{fill:#f0c44e;}
  .follower-segment{fill:#5a9ee6;}
  .unknown-segment{fill:#9b92b5;}
  .chart-bar{cursor:pointer;}
  .chart-bar:focus{outline:none;}
  .bar-highlight{fill:none;stroke:var(--text);stroke-width:2;vector-effect:non-scaling-stroke;pointer-events:none;}
  .chart-legend{margin:0 0 12px;}
  .regular-swatch{background:#f0c44e;}
  .other-swatch{background:#5fc4aa;}
  .follower-swatch{background:#5a9ee6;display:inline-block;width:10px;height:10px;border-radius:2px;}
  .unknown-swatch{background:#9b92b5;display:inline-block;width:10px;height:10px;border-radius:2px;}
  .chart-pages{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px;justify-content:center;font-size:12px;}
  .chart-pages>span{text-align:center;overflow-wrap:anywhere;}
  .chart-caption{position:absolute;right:0;top:0;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);margin:0;}
  @media(max-width:720px){.chart-pages>button{font-size:12px;padding:8px;min-height:44px;}}
</style>
