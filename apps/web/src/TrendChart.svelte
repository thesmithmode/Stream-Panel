<script lang="ts">
  import {chartSeries, type ChartMetric, type ChartPoint} from './chart-series';
  let {points,metric}:{points:ChartPoint[];metric:ChartMetric}=$props();
  const buckets=$derived(chartSeries(points,metric));
  const maximum=$derived(Math.max(1,...buckets.map(p=>p.value)));
  const start=$derived(buckets[0]?.at??0),end=$derived((buckets.at(-1)?.at??0)+(buckets[0]?.width??60000));
  const split=$derived(metric!=='viewers');
  const height=(value:number)=>value>0?Math.max(1,value/maximum*160):0;
  function title(point:typeof buckets[number]) {
    const label=`${new Date(point.at).toLocaleString('ru-RU')} · ${Math.round(point.width/60000)} мин`;
    if(!point.known)return `${label} · нет данных`;
    const regular=split&&point.value>0?` · постоянники: ${point.regularValue.toFixed(1)} (${(point.regularValue/point.value*100).toFixed(1)}%)`:'';
    return `${label} · всего: ${point.value.toFixed(1)}${regular}`;
  }
</script>
<div class="trend-chart">
  {#if !buckets.length}<p class="muted">Пока нет точек для графика</p>{:else}
    {#if split}<div class="legend chart-legend"><span><i class="regular-swatch"></i>Постоянники — снизу, жёлтым</span><span><i class:estimated={metric==='estimated'} class="other-swatch"></i>Остальные</span></div>{/if}
    <svg viewBox="0 0 800 220" role="img" aria-label="График активности по выбранному периоду">
      <line x1="32" y1="190" x2="790" y2="190" stroke="currentColor" opacity=".25" />
      <text x="5" y="24" fill="currentColor" font-size="12">{Math.round(maximum)}</text><text x="8" y="190" fill="currentColor" font-size="12">0</text>
      {#each buckets as p}
        {@const barHeight=height(p.value)}
        {@const regularHeight=p.value>0?barHeight*p.regularValue/p.value:0}
        <g class="chart-bar">
          <rect class="total-segment" x={32+(p.at-start)/(end-start)*750} y={p.known?190-barHeight:185} width={Math.max(1,p.width/(end-start)*750-1)} height={p.known?barHeight:5} class:unknown={!p.known} class:estimated={metric==='estimated'}><title>{title(p)}</title></rect>
          {#if split&&p.known&&regularHeight>0}<rect class="regular-segment" x={32+(p.at-start)/(end-start)*750} y={190-regularHeight} width={Math.max(1,p.width/(end-start)*750-1)} height={regularHeight}><title>{title(p)}</title></rect>{/if}
        </g>
      {/each}
      <text x="32" y="213" fill="currentColor" font-size="12">{new Date(start).toLocaleDateString('ru-RU')}</text><text x="690" y="213" fill="currentColor" font-size="12">{new Date(end).toLocaleDateString('ru-RU')}</text>
    </svg>
    <p class="small muted">Столбец — до {Math.round((buckets[0]?.width??60000)/60000)} мин. Для участников — среднее по сигналам, для сообщений — сумма. {split?'Жёлтая часть входит в общую высоту; наведите, чтобы увидеть её долю.':'Агрегатный счётчик площадки не раскрывает долю постоянников.'}</p>
  {/if}
</div>
