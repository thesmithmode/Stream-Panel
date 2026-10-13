<script lang="ts">
  import {chartSeries,isMessageMetric, type ChartMetric, type ChartPoint} from './chart-series';
  import {chartLayout,chartPages} from './chart-layout';
  import Help from './Help.svelte';
  const id=$props.id();
  import {timelineTicks} from './chart-detail';
  let {points,metric,resolution=1,showRegulars=true,timezone='Europe/Moscow',onselect}:{points:ChartPoint[];metric:ChartMetric;resolution?:number;showRegulars?:boolean;timezone?:string;onselect?:(point:ReturnType<typeof chartSeries>[number])=>void}=$props();
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
  const timeFormatter=$derived(new Intl.DateTimeFormat('ru-RU',{timeZone:timezone,hour:'2-digit',minute:'2-digit'}));
  const dateFormatter=$derived(new Intl.DateTimeFormat('ru-RU',{timeZone:timezone,day:'2-digit',month:'2-digit'}));
  const crossesDay=$derived(dateFormatter.format(start)!==dateFormatter.format(end));
  const detailFormatter=$derived(new Intl.DateTimeFormat('ru-RU',{timeZone:timezone,dateStyle:'short',timeStyle:'medium'}));
  const timeLabel=(at:number)=>timeFormatter.format(at);
  const split=$derived(showRegulars&&!['viewers','twitchViewers','youtubeViewers'].includes(metric));
  const hasUnknown=$derived(buckets.some(p=>(p.unknownValue??0)>0));
  const height=(value:number)=>value>0?Math.max(1,value/maximum*160):0;
  function title(point:typeof buckets[number]) {
    const label=`${detailFormatter.format(point.at)} · ${Math.round(point.width/60000)} мин`;
    if(point.isBreak)return `${label} · Перерыв`;
    if(!point.known)return `${label} · нет данных`;
    const partial=point.partial?' · неполные замеры площадок':'';
    const regular=split&&point.value>0?` · ядро: ${point.regularValue.toFixed(1)} (${(point.regularValue/point.value*100).toFixed(1)}%)`:'';
    const groups=split?` · подписчики: ${point.followerValue.toFixed(1)} · залётные: ${Math.max(0,point.value-point.regularValue-point.followerValue-(point.unknownValue??0)).toFixed(1)}${hasUnknown?` · статус неизвестен: ${(point.unknownValue??0).toFixed(1)}`:''}`:'';
    return `${label} · всего: ${point.value.toFixed(1)}${regular}${groups}${partial}`;
  }
  const titles=$derived(new Map(buckets.map(point=>[point.at,title(point)])));
</script>
<div class="trend-chart" bind:clientWidth={availableWidth}>
  {#if !buckets.length}<p class="muted">Пока нет точек для графика</p>{:else}
    {#if split}<div class="legend chart-legend"><span><i class="regular-swatch"></i>Ядро аудитории</span><span><i class="follower-swatch"></i>Подписчики</span><span><i class="other-swatch"></i>{isMessageMetric(metric)?'Залётные':'Остальные участники'}</span>{#if hasUnknown}<span><i class="unknown-swatch"></i>Статус подписки неизвестен</span>{/if}</div>{/if}
    {#if !split}<p class="small muted viewer-groups">Площадки не раскрывают состав всех зрителей. Разделение на группы доступно для сообщений.</p>{/if}
    <div class="trend-plot"><svg viewBox={`0 0 ${plotWidth} 245`} style="width:100%;display:block" role="group" aria-label="График активности по выбранному периоду">
      <line x1="32" y1="190" x2={plotWidth-10} y2="190" stroke="currentColor" opacity=".25" />
      <text x="5" y="24" fill="currentColor" font-size="12">{Math.round(maximum)}</text><text x="8" y="190" fill="currentColor" font-size="12">0</text>
      {#each buckets as p}
        {@const barHeight=height(p.value)}
        {@const regularHeight=p.value>0?barHeight*p.regularValue/p.value:0}
        {@const followerHeight=split&&p.value>0?barHeight*p.followerValue/p.value:0}
        {@const unknownHeight=split&&p.value>0?barHeight*(p.unknownValue??0)/p.value:0}
        <g class="chart-bar" role="button" tabindex="0" aria-label={titles.get(p.at)} onclick={()=>onselect?.(p)} onkeydown={(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onselect?.(p);}}}>
          <rect class="total-segment" x={32+(p.at-start)/(end-start)*(plotWidth-50)} y={p.known?190-barHeight:185} width={Math.max(.2,p.width/(end-start)*(plotWidth-50)*.9)} height={p.known?barHeight:5} class:unknown={!p.known} class:estimated={metric==='estimated'}><title>{titles.get(p.at)}</title></rect>
          {#if split&&p.known&&regularHeight>0}<rect class="regular-segment" x={32+(p.at-start)/(end-start)*(plotWidth-50)} y={190-regularHeight} width={Math.max(.2,p.width/(end-start)*(plotWidth-50)*.9)} height={regularHeight}><title>{titles.get(p.at)}</title></rect>{/if}
          {#if split&&p.known&&followerHeight>0}<rect class="follower-segment" x={32+(p.at-start)/(end-start)*(plotWidth-50)} y={190-regularHeight-followerHeight} width={Math.max(.2,p.width/(end-start)*(plotWidth-50)*.9)} height={followerHeight}><title>{titles.get(p.at)}</title></rect>{/if}
          {#if split&&p.known&&unknownHeight>0}<rect class="unknown-segment" x={32+(p.at-start)/(end-start)*(plotWidth-50)} y={190-regularHeight-followerHeight-unknownHeight} width={Math.max(.2,p.width/(end-start)*(plotWidth-50)*.9)} height={unknownHeight}><title>{titles.get(p.at)}</title></rect>{/if}
          <rect x={32+(p.at-start)/(end-start)*(plotWidth-50)} y="25" width={Math.max(1,p.width/(end-start)*(plotWidth-50))} height="165" fill="transparent" style="pointer-events:all;fill:transparent"><title>{titles.get(p.at)}</title></rect>
        </g>
      {/each}
      {#each ticks as at,i}
        {@const x=32+(at-start)/(end-start)*(plotWidth-50)}
        <line x1={x} y1="190" x2={x} y2="197" stroke="currentColor" opacity=".4" />
        {#if i%layout.labelEvery===0}<text x={Math.max(38,Math.min(x,plotWidth-38))} y="213" text-anchor="middle" fill="currentColor" font-size="12">{timeLabel(at)}</text>
        {#if crossesDay}<text x={Math.max(38,Math.min(x,plotWidth-38))} y="231" text-anchor="middle" fill="currentColor" font-size="10">{dateFormatter.format(at)}</text>{/if}{/if}
      {/each}
    </svg></div>
    {#if pages.length>1}<div class="chart-pages"><button class="outline small" disabled={pageOffset+1>=pages.length} onclick={()=>pageOffset++}>Раньше</button><span>{new Date(start).toLocaleDateString('ru-RU',{timeZone:timezone})} · {timeLabel(start)}–{timeLabel(end)}</span><button class="outline small" disabled={pageOffset===0} onclick={()=>pageOffset--}>Позже</button></div>{/if}
    <div class="chart-caption"><span>Столбец: {Math.round((buckets[0]?.width??60000)/60000)} мин · {timezone}</span><Help id={`${id}-help`} label="Как читать график" text="Нажмите столбец для детализации. Шкала — каждые 15 минут; для периодов длиннее суток шаг укрупняется. Интервал столбца выбирается: 1, 5 или 15 минут; длинный период листается блоками; внутри выбранного столбца можно выбрать отдельную минуту. Для зрителей высота — среднее по известным замерам, для сообщений — сумма. Ядро имеет приоритет над подпиской; залётные — авторы с подтверждённым отсутствием подписки, неизвестный статус показан отдельно. Зрители (все) — сумма средних замеров Twitch и YouTube; неполные замеры отмечены в детализации. Жёлтый сегмент — ядро аудитории. Серые отметки — нет данных."/></div>
  {/if}
</div>

<style>
  .viewer-groups{margin:0 0 12px}.unknown-swatch{background:#9b92b5}.trend-chart rect.unknown-segment{fill:#9b92b5}.legend .unknown-swatch{display:inline-block;width:10px;height:10px;border-radius:2px}
  .chart-pages{display:flex;align-items:center;gap:12px;justify-content:center;flex-wrap:wrap;font-size:12px;}
  .chart-caption{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);margin-top:8px;}
  .trend-chart{width:100%;min-width:0;}
  .trend-plot{width:100%;min-width:0;}
  svg{overflow:hidden;height:auto;}
  .chart-bar{cursor:pointer;}
  .chart-bar:focus{outline:2px solid currentColor;}
</style>
