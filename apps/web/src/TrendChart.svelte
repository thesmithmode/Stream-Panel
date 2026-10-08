<script lang="ts">
  let {points,metric}:{points:any[];metric:string}=$props();
  const buckets=$derived.by(()=>{
    if(!points.length)return [];
    const width=Math.max(60000,Math.ceil((points.at(-1).at-points[0].at+60000)/240/60000)*60000),map=new Map<number,{at:number;total:number;n:number;known:boolean}>();
    for(const p of points){const at=Math.floor(p.at/width)*width;let b=map.get(at);if(!b){b={at,total:0,n:0,known:false};map.set(at,b);}const known=metric==="observed"?p.presenceKnown:metric==="viewers"?p.viewers!==null:true;if(known){b.total+=Number(p[metric]??0);b.n++;b.known=true;}}
    return [...map.values()].sort((a,b)=>a.at-b.at).map(b=>({...b,value:metric==="messages"?b.total:b.n?b.total/b.n:0,width}));
  });
  const maximum=$derived(Math.max(1,...buckets.map(p=>p.value)));
  const start=$derived(buckets[0]?.at??0),end=$derived((buckets.at(-1)?.at??0)+(buckets[0]?.width??60000));
</script>
<div class="trend-chart">
  {#if !buckets.length}<p class="muted">Пока нет точек для графика</p>{:else}
    <svg viewBox="0 0 800 220" role="img" aria-label="График активности по выбранному периоду">
      <line x1="32" y1="190" x2="790" y2="190" stroke="currentColor" opacity=".25" />
      <text x="5" y="24" fill="currentColor" font-size="12">{Math.round(maximum)}</text><text x="8" y="190" fill="currentColor" font-size="12">0</text>
      {#each buckets as p}<rect x={32+(p.at-start)/(end-start)*750} y={p.known?190-p.value/maximum*160:185} width={Math.max(1,p.width/(end-start)*750-1)} height={p.known?Math.max(1,p.value/maximum*160):5} class:unknown={!p.known} class:estimated={metric==="estimated"}>
        <title>{new Date(p.at).toLocaleString("ru-RU")} · {Math.round(p.width/60000)} мин · {p.known?p.value.toFixed(1):"нет данных"}</title>
      </rect>{/each}
      <text x="32" y="213" fill="currentColor" font-size="12">{new Date(start).toLocaleDateString("ru-RU")}</text><text x="690" y="213" fill="currentColor" font-size="12">{new Date(end).toLocaleDateString("ru-RU")}</text>
    </svg>
    <p class="small muted">Столбец — до {Math.round((buckets[0]?.width??60000)/60000)} мин. Для участников — среднее по сигналам, для сообщений — сумма; точные минуты доступны в детализации участника.</p>
  {/if}
</div>
