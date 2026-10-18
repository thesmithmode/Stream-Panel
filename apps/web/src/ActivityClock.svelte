<script lang="ts">
 import type {Snippet} from 'svelte';
 import {clockActivitySeries,clockDonationSeries,clockAxis,type ClockActivity} from '../../../packages/core/src/clock-activity';
 import {clockLabel,timeAudience,type Window,type TimePerson,type TimeAudienceSummary} from './time-audience';
 import TimeAudience from './TimeAudience.svelte';
 import type {ActivityMetric} from './analytics-view';
 import {chartMetrics} from './chart-series';
 import Help from './Help.svelte';
 import PeriodSelect from './PeriodSelect.svelte';
 let {categoryFilter,rows,metric=$bindable('viewers'),resolution=$bindable(15),timezone,period='all',onperiod,windows=[],people=[],summary=[],onPerson,loadVisitors}:{categoryFilter:Snippet<[string]>;rows:ClockActivity[];metric?:ActivityMetric;resolution?:number;timezone:string;period?:number|'all'|'custom';onperiod:(value:number|'all'|'custom')=>void;windows?:Window[];people?:TimePerson[];summary?:TimeAudienceSummary[];onPerson:(id:string)=>void;loadVisitors?:(params:Record<string,string|number>,signal:AbortSignal)=>Promise<any>}=$props();
 let day=$state('all'),currency=$state('RUB'),selected=$state<number|null>(null),availableWidth=$state(800);
 const plotWidth=$derived(Math.max(300,availableWidth));
 const step=$derived([1,5,15,30,60].includes(resolution)?resolution:15);
 const attendance=$derived(summary.length?summary.filter(b=>b.day===day&&b.resolution===step):timeAudience(windows,people,timezone,step,day).map(b=>({...b,streams:b.streams.size,people:[]})));
 const currencies=$derived([...new Set(rows.flatMap(row=>Object.keys(row.donationAmounts??{})))].sort());
 const activeCurrency=$derived(currencies.includes(currency)?currency:currencies[0]??'RUB');
 const buckets=$derived((metric==='activeAudience'?Array.from({length:1440/step},(_,i)=>{const minute=i*step,b=attendance.find(b=>b.minute===minute);return {minute,value:b?.averageAudience??null,duration:b?.airtimeMs??0,total:b?.personTimeMs??0};}):metric==='donations'?clockDonationSeries(rows,activeCurrency,step,day):clockActivitySeries(rows,metric,step,day)));
 const start=0,span=1440,ticks=[0,360,720,1080,1440],timeGrid=[180,360,540,720,900,1080,1260];
 const levels=$derived(clockAxis(Math.max(0,...buckets.map(b=>b.value??0))));
 const maximum=$derived(levels.at(-1)!);
 const chosen=$derived(buckets.find(b=>b.minute===selected));
 const choices=[...chartMetrics,{value:'activeAudience',label:'Активные участники'},{value:'watchHours',label:'Часы просмотра (все)'},{value:'twitchWatchHours',label:'Часы просмотра Twitch'},{value:'youtubeWatchHours',label:'Часы просмотра YouTube'},{value:'donations',label:'Донаты · сумма / час'}];
 const watchHours=$derived(metric.endsWith('WatchHours')||metric==='watchHours');
 const unit=$derived(watchHours?' зритель·ч':metric==='donations'?` ${activeCurrency}/ч`:metric.endsWith('Messages')||metric==='messages'?' сообщ./ч':metric==='activeAudience'?' активных участников':' зрителей');
 const label=(value:number|null)=>value===null?'нет данных':value.toLocaleString('ru-RU',{maximumFractionDigits:2});
 const description=(b:typeof buckets[number])=>`${clockLabel(b.minute)}–${clockLabel(b.minute+step)}: ${label(b.value)}${b.value===null?'':unit} · ${label(b.duration/60000)} мин с данными`;
 $effect(()=>{void metric;void step;void day;void rows;void activeCurrency;selected=null;});
</script>
<section class="panel activity-clock">
 <header><h2>Активность по часам</h2><Help id="activity-clock-help" label="О суточном графике" text="Все дни выбранного периода совмещены на шкале 00:00–24:00 в часовом поясе аналитики. Зрители — среднее по времени с известными замерами; сообщения — число на час эфира. Время без эфиров и пропущенные замеры не считаются нулями. Для общей аудитории используются только полные замеры площадок. Сумма зрителей площадок не означает уникальных людей. Активные участники — известные люди по наблюдениям Twitch и сигналам чата; это отдельная метрика. Нажмите столбец, чтобы увидеть людей и их явку за тот же интервал. Часы просмотра — накопленная сумма: онлайн × фактическое время известных замеров; она зависит от количества эфиров. Донаты — сумма в выбранной валюте на час эфира, только во время записанных эфиров. Нажмите столбец для точного значения."/></header>{@render categoryFilter("Категория суточного графика")}
 <div class="clock-controls">
  <PeriodSelect value={period} label="Период суточного графика" days={[7,30]} custom={period==='custom'} onchange={onperiod}/>
  <label>Метрика графика<select bind:value={metric}>{#each choices as choice}<option value={choice.value}>{choice.label}</option>{/each}</select></label>
  <label>Шаг графика<select bind:value={resolution}><option value={1}>1м</option><option value={5}>5м</option><option value={15}>15м</option><option value={30}>30м</option><option value={60}>1ч</option></select></label>
  <label>Дни недели<select bind:value={day}><option value="all">Все дни</option><option value="weekdays">Будни</option><option value="weekends">Выходные</option>{#each ['пн','вт','ср','чт','пт','сб','вс'] as d}<option value={d}>{d}</option>{/each}</select></label>
  {#if metric==='donations'}<label>Валюта донатов графика<select bind:value={currency}>{#each currencies as c}<option value={c}>{c}</option>{:else}<option value="RUB">RUB</option>{/each}</select></label>{/if}
 </div>
 <p class="small muted clock-caption">{watchHours?'Часы просмотра за выбранный период · накопленная сумма':metric==='donations'?`Сумма донатов на час эфира · ${activeCurrency}`:metric.endsWith('Messages')||metric==='messages'?'Сообщения на час эфира':metric==='activeAudience'?'Средняя активная аудитория за время эфира':'Среднее число зрителей во время эфира'} · {timezone}</p>
 <div class="clock-plot" bind:clientWidth={availableWidth}><svg viewBox={`0 0 ${plotWidth} 250`} role="group" aria-label={`Активность с ${clockLabel(start)} до ${clockLabel(start+span)}`}>
  {#each levels as value}
   {@const y=200-value/maximum*170}
   <line class="value-grid" x1="45" x2={plotWidth-25} y1={y} y2={y} stroke="currentColor" opacity=".15"/>
   <text class="value-tick" x="39" y={y+4} text-anchor="end" fill="currentColor" font-size="11">{value.toLocaleString('ru-RU',{notation:'compact',maximumFractionDigits:2})}</text>
  {/each}
  {#each timeGrid as minute}<line class="time-grid" x1={45+minute/1440*(plotWidth-70)} x2={45+minute/1440*(plotWidth-70)} y1="30" y2="200" stroke="currentColor" opacity=".1"/>{/each}
  <line x1="45" x2={plotWidth-25} y1="200" y2="200" stroke="currentColor" opacity=".3"/>
  {#each buckets as b}
   {@const height=(b.value??0)/maximum*170}
   <g class:chosen={selected===b.minute} role="button" tabindex="0" aria-label={description(b)} onclick={()=>selected=b.minute} onkeydown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selected=b.minute;}}}>
    <rect x={45+(b.minute-start)/span*(plotWidth-70)} y={b.value===null?196:200-height} width={Math.max(.3,step/span*(plotWidth-70)*.9)} height={b.value===null?4:height} fill={b.value===null?'#737c8a':'var(--teal)'} opacity={b.value===null?.35:1}><title>{description(b)}</title></rect>
    <rect x={45+(b.minute-start)/span*(plotWidth-70)} y="25" width={step/span*(plotWidth-70)} height="175" fill="transparent"><title>{description(b)}</title></rect>
   </g>
  {/each}
  {#each ticks as minute}<text x={45+(minute-start)/span*(plotWidth-70)} y="230" text-anchor={minute===start?'start':minute===start+span?'end':'middle'} fill="currentColor" font-size="12">{clockLabel(minute)}</text>{/each}
 </svg></div>
 <p class="clock-caption small" role="status">{chosen?description(chosen):'Нажмите столбец: точное значение, люди и их явка. Серый — нет данных.'}</p>
<TimeAudience {windows} {people} {summary} {timezone} {onPerson} {loadVisitors} {day} resolution={step} {selected}/>
</section>
<style>
 .clock-controls{display:flex;flex-wrap:wrap;gap:12px;padding:16px 20px}.clock-controls label{display:grid;gap:6px;font-size:12px;flex:1 1 160px;min-width:0}select{width:100%;min-width:0}.clock-caption{padding:0 20px 12px;margin:0}.clock-plot{padding:8px 16px;min-width:0}svg{display:block;width:100%;height:auto;overflow:visible}g{cursor:pointer}g.chosen{outline:1px solid var(--accent)}g:focus{outline:2px solid var(--accent)}
 @media(max-width:600px){.clock-plot{padding:8px}.clock-controls{padding:12px;gap:10px}.clock-caption{padding-left:12px;padding-right:12px}}
</style>
