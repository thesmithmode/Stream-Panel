<script lang="ts">
 import type {Snippet} from 'svelte';
 import {clockActivitySeries,type ClockActivity,type ClockMetric} from '../../../packages/core/src/clock-activity';
 import {clockLabel} from './time-audience';
 import {chartMetrics,type ChartMetric,isMessageMetric} from './chart-series';
 import Help from './Help.svelte';
 import PeriodSelect from './PeriodSelect.svelte';
 let {categoryFilter,rows,metric=$bindable('viewers'),resolution=$bindable(15),timezone,period='all',onperiod}:{categoryFilter:Snippet<[string]>;rows:ClockActivity[];metric?:ChartMetric;resolution?:number;timezone:string;period?:number|'all'|'custom';onperiod:(value:number|'all'|'custom')=>void}=$props();
 let day=$state('all'),selected=$state<number|null>(null),availableWidth=$state(800);
 const plotWidth=$derived(Math.max(300,availableWidth));
 const step=$derived([1,15,30,60].includes(resolution)?resolution:15);
 const buckets=$derived(clockActivitySeries(rows,metric as ClockMetric,step,day));
 const maximum=$derived(Math.max(1,...buckets.map(b=>b.value??0)));
 const chosen=$derived(buckets.find(b=>b.minute===selected));
 const messages=$derived(isMessageMetric(metric));
 const label=(value:number|null)=>value===null?'нет данных':value.toLocaleString('ru-RU',{maximumFractionDigits:2});
 const description=(b:typeof buckets[number])=>`${clockLabel(b.minute)}–${clockLabel(b.minute+step)}: ${label(b.value)}${b.value===null?'':messages?' сообщ./ч':' зрителей'}`;
 $effect(()=>{void metric;void step;void day;void rows;selected=null;});
</script>
<section class="panel activity-clock">
 <header><h2>Активность по времени суток</h2><Help id="activity-clock-help" label="О суточном графике" text="Все дни выбранного периода совмещены на шкале 00:00–24:00 в часовом поясе аналитики. Зрители — среднее по времени с известными замерами; сообщения — число на час эфира. Время без эфиров и пропущенные замеры не считаются нулями. Для общей аудитории используются только полные замеры площадок. Сумма зрителей площадок не означает уникальных людей. Нажмите столбец для точного значения."/></header>{@render categoryFilter("Категория суточного графика")}
 <div class="clock-controls">
  <PeriodSelect value={period} label="Период суточного графика" days={[7,30]} custom={period==='custom'} onchange={onperiod}/>
  <label>Метрика графика<select bind:value={metric}>{#each chartMetrics as choice}<option value={choice.value}>{choice.label}</option>{/each}</select></label>
  <label>Шаг графика<select bind:value={resolution}><option value={1}>1м</option><option value={15}>15м</option><option value={30}>30м</option><option value={60}>1ч</option></select></label>
  <label>Дни недели<select bind:value={day}><option value="all">Все дни</option><option value="weekdays">Будни</option><option value="weekends">Выходные</option></select></label>
 </div>
 <p class="small muted clock-caption">{messages?'Сообщения на час эфира':'Среднее число зрителей во время эфира'} · {timezone}</p>
 <div class="clock-plot" bind:clientWidth={availableWidth}><svg viewBox={`0 0 ${plotWidth} 250`} role="group" aria-label="Активность за полные сутки с 00:00 до 24:00">
  <text x="4" y="20" fill="currentColor" font-size="16">{label(maximum)}</text><text x="14" y="200" fill="currentColor" font-size="16">0</text>
  <line x1="45" x2={plotWidth-25} y1="200" y2="200" stroke="currentColor" opacity=".3"/>
  {#each buckets as b}
   {@const height=(b.value??0)/maximum*170}
   <g role="button" tabindex="0" aria-label={description(b)} onclick={()=>selected=b.minute} onkeydown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selected=b.minute;}}}>
    <rect x={45+b.minute/1440*(plotWidth-70)} y={b.value===null?196:200-height} width={Math.max(.3,step/1440*(plotWidth-70)*.9)} height={b.value===null?4:height} fill={b.value===null?'#737c8a':'var(--teal)'} opacity={b.value===null?.35:1}><title>{description(b)}</title></rect>
    <rect x={45+b.minute/1440*(plotWidth-70)} y="25" width={step/1440*(plotWidth-70)} height="175" fill="transparent"><title>{description(b)}</title></rect>
   </g>
  {/each}
  {#each [0,360,720,1080,1440] as minute}<text x={45+minute/1440*(plotWidth-70)} y="230" text-anchor={minute===0?'start':minute===1440?'end':'middle'} fill="currentColor" font-size="12">{clockLabel(minute)}</text>{/each}
 </svg></div>
 <p class="clock-caption small" role="status">{chosen?description(chosen):'Нажмите столбец для точного значения. Серый — нет данных.'}</p>
</section>
<style>
 .clock-controls{display:flex;flex-wrap:wrap;gap:12px;padding:16px 20px}.clock-controls label{display:grid;gap:6px;font-size:12px;flex:1 1 160px;min-width:0}select{width:100%;min-width:0}.clock-caption{padding:0 20px 12px;margin:0}.clock-plot{padding:8px 16px;min-width:0}svg{display:block;width:100%;height:auto;overflow:visible}g{cursor:pointer}g:focus{outline:2px solid var(--accent)}
 @media(max-width:600px){.clock-plot{padding:8px}.clock-controls{padding:12px;gap:10px}.clock-caption{padding-left:12px;padding-right:12px}}
</style>
