<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { api, date, money } from "./api";
  import {analyticsView,loadAnalyticsView,saveAnalyticsView} from "./analytics-view";
  import YoutubeReport from "./YoutubeReport.svelte";
  import Insights from "./Insights.svelte";
  import Help from "./Help.svelte";
  import PeriodSelect from './PeriodSelect.svelte';
  import ActivityClock from "./ActivityClock.svelte";
  import {localDateWindow} from "./time-audience";
  import DonationPatterns from './DonationPatterns.svelte';
  import {platformClass} from './period';
  import TimePatterns from "./TimePatterns.svelte";
  import ComparisonCharts from "./ComparisonCharts.svelte";
  let { profile = "local", defaultTimezone="Europe/Moscow", onPerson, onStream }: {profile?:string;defaultTimezone?:string;onPerson:(id:string)=>void;onStream:(id:string)=>void} = $props();
  let view=$state(analyticsView(null));
  const localInput=(at:number)=>{const d=new Date(at);return new Date(at-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
  let from=$state(localInput(0)),to=$state(localInput(Date.now())),source=$state("all"),category=$state("");
  let timezone=$state(untrack(()=>defaultTimezone));
  let search=$state(""),liveEnd=$state(true),data=$state<any>(null),error=$state(""),busy=$state(false),selected=$state<any>(null),day=$state("");
  let heatCurrency=$state("RUB"),reportError=$state("");
  let heatCalculation=$state("average"),selectedHour=$state<{day:string;hour:number}|null>(null);
  let period=$state<number|'all'|'custom'>('all');
  let buildProgress=$state(""),detailData=$state<any>(null),detailBusy=$state(false),streamPage=$state(0);
  const reportScope=$derived(JSON.stringify([profile,period,period==='custom'?from:'',period==='custom'?to:'',source,category,timezone]));
  let loadedScope=$state('');
  let requestId=0, mounted=$state(false);
  $effect(()=>{
    const filters=[mounted,from,to,source,category,timezone].join("|");
    void filters;
    if(!mounted)return;
    busy=true;error="";
    let cancelled=false;
    const timer=window.setTimeout(()=>{if(!cancelled)untrack(()=>void refresh());},250);
    return ()=>{cancelled=true;window.clearTimeout(timer);requestId++;};
  });
  $effect(()=>{const saved=JSON.stringify(view);void saved;if(mounted)saveAnalyticsView(()=>localStorage,profile,view);});
  let audienceOffset=$state(0),pagedAudience=$state<any>(null),audienceBusy=$state(false);
  $effect(()=>{void reportScope;pagedAudience=null;});
  const visible=$derived(data?.audiencePage?(pagedAudience?.audience??data.audience):(data?.audience??[]).filter((e:any)=>(!view.coreOnly||e.core)&&e.name.toLowerCase().includes(search.toLowerCase())).sort((a:any,b:any)=>view.sort==="sessions"?(b.sessionCount??b.sessionIds.length)-(a.sessionCount??a.sessionIds.length):(b[view.sort]??0)-(a[view.sort]??0)));
  async function reportPage(extra:Record<string,string|number>,signal?:AbortSignal,endpoint='analytics',filters=data?.filters){
    if(!filters)throw new Error('Отчёт ещё не загружен');
    const q=new URLSearchParams(Object.entries({...filters,from:filters.fromMs,to:filters.toMs,mode:'summary',insights:'1',...extra}).map(([key,value])=>[key,String(value)]));
    let result=await api(`${endpoint}?${q}`,undefined,signal);
    while(result.preparing&&!signal?.aborted){await new Promise(resolve=>setTimeout(resolve,100));result=await api(`${endpoint}?${q}`,undefined,signal);}
    return result;
  }
  const visitorLoader=$derived.by(()=>{const filters=data?.filters;return (params:Record<string,string|number>,signal:AbortSignal)=>reportPage(params,signal,'analytics/clock',filters);});
  $effect(()=>{void search;void view.sort;void view.coreOnly;void reportScope;audienceOffset=0;});
  $effect(()=>{
    const current=data,offset=audienceOffset,term=search,sort=view.sort,core=view.coreOnly;
    audienceBusy=false;
    if(!current?.audiencePage)return;
    const controller=new AbortController();audienceBusy=true;
    const timer=window.setTimeout(()=>{void reportPage({audienceOffset:offset,audienceSearch:term,audienceSort:sort,audienceCoreOnly:core?1:0},controller.signal).then(result=>{if(!controller.signal.aborted)pagedAudience=result;}).catch(e=>{if(!controller.signal.aborted)error=e.message;}).finally(()=>{if(!controller.signal.aborted)audienceBusy=false;});},150);
    return ()=>{controller.abort();window.clearTimeout(timer);};
  });
  const reportPending=$derived(!!data&&loadedScope!==reportScope);
  const weekdays=["пн","вт","ср","чт","пт","сб","вс"];
  const hourCells=$derived(new Map((data?.hours??[]).map((h:any)=>[`${h.day}:${h.hour}`,h])) as Map<string,any>);
  const hourStreamCounts=$derived(new Map((data?.clockBuckets??[]).filter((b:any)=>b.resolution===60&&weekdays.includes(b.day)).map((b:any)=>[`${b.day}:${b.minute/60}`,b.streams])));
  function heatValue(cell:any):number|null {
    if(!cell)return null;
    if(view.heatMetric==='donations')return cell.sampleMinutes?(heatCalculation==='total'?cell.donationCount:cell.donationCount*60/cell.sampleMinutes):null;
    if(view.heatMetric==='amount')return cell.sampleMinutes?Number((heatCalculation==='total'?cell.donationTotals:cell.donationsPerHourMinor)[heatCurrency]??'0'):null;
    if(heatCalculation==="total")return view.heatMetric==="viewers"?((cell.knownViewerSamples??cell.viewerSamples)?(cell.knownViewersTotal??cell.viewersTotal):null):view.heatMetric==="observed"?(cell.observedKnownMinutes?cell.observed:null):view.heatMetric==="estimated"?cell.estimated:cell.messages;
    if(view.heatMetric==="viewers")return (cell.knownViewerSamples??cell.viewerSamples)?(cell.knownViewersTotal??cell.viewersTotal)/(cell.knownViewerSamples??cell.viewerSamples):null;
    if(view.heatMetric==="messages")return cell.sampleMinutes?cell.messages*60/cell.sampleMinutes:null;
    if(view.heatMetric==="estimated")return cell.sampleMinutes?cell.estimated/cell.sampleMinutes:null;
    return cell.observedKnownMinutes?cell.observed/cell.observedKnownMinutes:null;
  }
  const partialViewers=$derived((data?.hours??[]).some((cell:any)=>(cell.viewerPartialMinutes??0)>0));
  const hourMax=$derived(Math.max(1,...(data?.hours??[]).map((h:any)=>heatValue(h)??0)));
  function hourTitle(day:string,hour:number){
    const cell=hourCells.get(`${day}:${hour}`),value=heatValue(cell);
    const count=hourStreamCounts.get(`${day}:${hour}`);
    const known=view.heatMetric==='viewers'?(cell?.knownViewerSamples??cell?.viewerSamples):view.heatMetric==='observed'?cell?.observedKnownMinutes:cell?.sampleMinutes;
    return `${day} ${hour}:00 — ${value===null?"нет данных":view.heatMetric==='amount'?money(String(Math.round(value)),heatCurrency):`${value.toFixed(1)}`}${count===undefined?'':` · эфиров: ${count}`} · ${(known??0).toLocaleString('ru-RU',{maximumFractionDigits:1})} мин с данными`;
  }
  const categoryOptions=$derived([...(data?.availableCategories??data?.categories??[])].filter((c:any)=>c.id).sort((a:any,b:any)=>a.name.localeCompare(b.name,'ru')));
  const timelineByMinute=$derived(new Map((data?.aggregate?(detailData?.timeline??[]):(data?.timeline??[])).map((point:any)=>[point.at,point])) as Map<number,any>);
  const detailPerson=$derived(data?.aggregate?detailData?.audience?.find((p:any)=>p.id===selected?.id):selected);
  const detailMinutes=$derived.by(()=>{
    if(!selected||!day)return [];
    const bounds=localDateWindow(day,timezone),start=bounds.from;
    return Array.from({length:Math.ceil((bounds.to-bounds.from)/60000)},(_,i)=>{
      const at=start+i*60000,span=(detailPerson?.intervals??[]).find((s:any)=>s.from<at+60000&&s.to>at),known=timelineByMinute.get(at)?.presenceKnown;
      return {at,state:span?.kind==="chat_proxy"?"estimated":span?"observed":selected.source==="twitch"&&known?"not_observed":"unknown"};
    });
  });
  $effect(()=>{
    detailData=null;detailBusy=false;const person=selected?.id,currentDay=day,aggregate=data?.aggregate;
    if(!person||!currentDay||!aggregate)return;
    const bounds=localDateWindow(currentDay,timezone),controller=new AbortController();detailBusy=true;
    const q=new URLSearchParams({from:String(bounds.from),to:String(bounds.to),source,category,timezone});
    void api(`analytics?${q}`,undefined,controller.signal).then(result=>{if(!controller.signal.aborted)detailData=result;}).catch(e=>{if(!controller.signal.aborted)error=e.message;}).finally(()=>{if(!controller.signal.aborted)detailBusy=false;});
    return ()=>controller.abort();
  });
  function selectEntity(e:any){selected=e;day=new Date(e.intervals.at(-1)?.from??new Date(to).getTime()).toLocaleDateString('sv-SE',{timeZone:timezone});}
  function preset(days:number|'all'){period=days;liveEnd=true;const now=Date.now();from=localInput(days==='all'?0:now-days*86400000);to=localInput(now);}
  async function refresh(){
    const scope=reportScope,id=++requestId;busy=true;error="";reportError="";
    const fromMs=new Date(from).getTime(),toMs=new Date(to).getTime();
    try{
      try {localStorage.setItem(`sp-analytics-${profile}`,JSON.stringify({timezone}));}catch{/* optional local preferences */}
      const q=new URLSearchParams({from:String(fromMs),to:String(toMs),source,category,timezone,mode:'summary',insights:'1'});
      let result=await api(`analytics?${q}`);
      while(result.preparing&&id===requestId){buildProgress=`${result.stage==='aggregate'?'Собираем отчёт':'Готовим историю'}: ${Math.round(result.ready/Math.max(1,result.total)*100)}%`;await new Promise(resolve=>setTimeout(resolve,result.stage==='aggregate'?100:250));if(id!==requestId)return;result=await api(`analytics?${q}`);}
      buildProgress='';
      if(id===requestId){const previousScope=loadedScope;if(result.filters&&(result.filters.category!==category||result.filters.source!==source||result.filters.timezone!==timezone))throw new Error('Сервер вернул данные для других фильтров. Повторите обновление.');loadedScope=scope;
        if(JSON.stringify(data)!==JSON.stringify(result))data=Object.fromEntries(Object.entries(result).map(([key,value])=>[key,JSON.stringify(data?.[key])===JSON.stringify(value)?data[key]:value]));
        if(scope!==previousScope){selected=null;streamPage=0;}}
    }catch(e){if(id===requestId){error=(e as Error).message;reportError=error;}}
    finally{if(id===requestId)busy=false;}
  }
  onMount(()=>{
    try{const saved=JSON.parse(localStorage.getItem(`sp-analytics-${profile}`)??"null");if(saved?.timezone)timezone=saved.timezone;}catch{/* private browser may deny storage */}
    view=loadAnalyticsView(()=>localStorage,profile);
    mounted=true;const update=()=>{if(!document.hidden&&navigator.onLine&&!busy){if(liveEnd){const now=Date.now();if(typeof period==='number')from=localInput(now-period*86400000);const next=localInput(now);if(next===to)void refresh();else to=next;}else void refresh();}};window.addEventListener('sp:data-refresh',update);return ()=>{requestId++;window.removeEventListener('sp:data-refresh',update);};
  });
</script>
{#snippet categoryFilter(label:string)}
 <div class="chart-category" aria-busy={busy}><label>Категория<select aria-label={label} bind:value={category}><option value="">Все категории</option>{#each categoryOptions as c}<option value={c.id}>{c.name}</option>{/each}</select></label>{#if busy}<p class="small muted chart-refresh">Обновляем данные…</p>{:else if reportError}<p class="small chart-refresh">{reportError} {reportPending?'Прежние данные скрыты.':'Показаны последние полученные данные.'}</p>{/if}</div>
{/snippet}
<section class="panel analytics-filter">
  <header><h2>Период и фильтры</h2><PeriodSelect value={period} label="Период аналитики" days={[7,30]} custom onchange={value=>{if(value==='custom')period='custom';else preset(value);}}/></header>
  <div class="analytics-controls">
    <label class="analytics-date">Начало периода<input type="datetime-local" value={from===localInput(0)&&data?.sessions?.length?localInput(data.sessions[0].started_at_ms):from} oninput={e=>{period='custom';from=e.currentTarget.value;}} required /></label>
    <label class="analytics-date">Конец периода<input type="datetime-local" bind:value={to} onchange={()=>{liveEnd=false;period='custom';}} required /></label>
    <label>Площадка<select bind:value={source}><option value="all">Все площадки</option><option value="twitch">Twitch / DA</option><option value="youtube">YouTube</option></select></label>
    <span class="small muted" role="status">{busy?(buildProgress||"Обновляем аналитику…"):""}</span>
  </div>
  <details class="analytics-thresholds"><summary>Настроить отображение</summary><div class="analytics-controls">
    <label>Часовой пояс сравнения<select bind:value={timezone}><option value="Europe/Moscow">Москва</option><option value="UTC">UTC</option><option value="Asia/Yekaterinburg">Екатеринбург</option></select></label>

    <label>Вид дней и часов<select bind:value={view.hourView}><option value="both">Карта и таблица</option><option value="map">Только карта</option><option value="table">Только таблица</option></select></label>
    <label class="check"><input type="checkbox" bind:checked={view.report} /> Отчёт YouTube</label>
    <label class="check"><input type="checkbox" bind:checked={view.trend} /> График активности</label>
    <label class="check"><input type="checkbox" bind:checked={view.categories} /> Сравнение категорий</label>
    <label class="check"><input type="checkbox" bind:checked={view.hours} /> Дни и часы</label>
    <label class="check"><input type="checkbox" bind:checked={view.streams} /> Сравнение стримов</label>
    <label class="check"><input type="checkbox" bind:checked={view.audience} /> Возвращаемость участников</label>
    <button class="outline" onclick={()=>view=analyticsView(null)}>Сбросить отображение</button>
  </div></details>

</section>
<div class="analytics-category-filter">
 <label>Категория Twitch<select bind:value={category}><option value="">Все категории</option>{#each categoryOptions as c}<option value={c.id}>{c.name}</option>{/each}</select></label>
 <span class="small muted">Для всех графиков ниже · Twitch и YouTube используют общую категорию эфира</span>
 {#if category}<button class="outline small" onclick={()=>category=''}>Сбросить категорию</button>{/if}
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if data}
 <div class="analytics-results" class:report-pending={reportPending} aria-busy={reportPending}>
  <Insights report={data} loading={busy} {onPerson} {onStream}/>
  {#if view.hours}<section class="panel"><header><h2>Активность по дням и часам</h2><label>Метрика карты<select aria-label="Метрика карты" bind:value={view.heatMetric}><option value="viewers">Зрители (все)</option><option value="observed">Наблюдения Twitch</option><option value="estimated">Оценка активности YouTube</option><option value="messages">Сообщения</option><option value="donations">Число донатов</option><option value="amount">Сумма донатов</option></select></label>{#if view.heatMetric==='amount'}<label>Валюта карты<select aria-label="Валюта карты" bind:value={heatCurrency}>{#each [...new Set<string>((data.hours??[]).flatMap((h:any)=>Object.keys(h.donationTotals)))] as c}<option value={c}>{c}</option>{:else}<option value="RUB">RUB</option>{/each}</select></label>{/if}<label>Расчёт карты<select aria-label="Расчёт карты" bind:value={heatCalculation}><option value="average">Среднее / на час эфира</option><option value="total">Накопленная сумма</option></select></label></header>
    {@render categoryFilter("Категория карты активности")}
    {#if view.hourView!=="table"}{#if view.heatMetric==='viewers'&&partialViewers}<p class="small muted" style="padding:0 16px">Неполные данные площадок: показана сумма известных зрителей. Неизвестные значения не считаются нулями.</p>{/if}<div class="hour-heatmap" aria-label="Карта активности по дням и часам">
      <div class="heatmap-labels"><span></span>{#each Array.from({length:24},(_,i)=>i) as hour}<span>{hour}</span>{/each}</div>
      {#each weekdays as weekday}<div class="heatmap-row"><strong>{weekday}</strong>{#each Array.from({length:24},(_,i)=>i) as hour}<button aria-label={hourTitle(weekday,hour)} title={hourTitle(weekday,hour)} onclick={()=>selectedHour={day:weekday,hour}} style:background={heatValue(hourCells.get(`${weekday}:${hour}`))!==null?`rgba(95,196,170,${.15+.85*(heatValue(hourCells.get(`${weekday}:${hour}`))??0)/hourMax})`:"#3b4350"}></button>{/each}</div>{/each}
    </div>{/if}{#if selectedHour}<p class="analytics-help small" role="status">{hourTitle(selectedHour.day,selectedHour.hour)}</p>{/if}<div class="analytics-help"><Help id="analytics-hours" label="О карте активности" text="Яркость соответствует выбранной метрике. Наблюдения Twitch усредняются по минутам с полными опросами; оценка YouTube и сообщения — по записанным минутам эфира. Серый — нет данных."/></div></section>{/if}

  {#if view.trend}<ActivityClock scope={reportScope} visitorRevision={data.clockRevision} {categoryFilter} rows={data.activityClock??[]} windows={data.activityWindows??[]} people={data.audience??[]} summary={data.clockBuckets??[]} loadVisitors={visitorLoader} {onPerson} bind:metric={view.metric} bind:resolution={view.resolution} {timezone} {period} onperiod={value=>{if(value!=='custom')preset(value);}}/>{/if}

  <div class="timing-grid">
  {#if data.donationTiming}<DonationPatterns {categoryFilter} timing={data.donationTiming}/>{/if}

  {#if data.patterns&&data.composition}<TimePatterns {categoryFilter} {data} />{/if}
  </div>
  <ComparisonCharts scope={reportScope} {categoryFilter} {timezone} {onStream} streams={data.streamComparison??[]} categories={(data.categories??[]).filter((c:any)=>c.id&&c.name!=="Категория неизвестна")} />
  {#if view.audience}<section class="panel"><header><h2>Возвращаемость участников</h2><Help id="analytics-audience" label="О минутах в чате" text="Наблюдаемые минуты Twitch учитывают молчавших участников и исключают неизвестные промежутки. Оценка YouTube показана отдельно. Выберите сортировку по минутам или сообщениям; нажмите имя для подробностей."/><span>{data.audiencePage?(pagedAudience?.audiencePage?.total??data.audiencePage.total):visible.length} профилей</span></header>
    <p class="small regular-summary">Ядро аудитории: <strong>{data.summary.regulars??0} из {data.summary.entities??0} ({data.summary.regularShare==null?"нет данных":(data.summary.regularShare*100).toFixed(1)+"%"})</strong></p>
    <div class="analytics-controls"><label>Поиск участника<input bind:value={search} placeholder="Имя" /></label><label>Сортировка<select bind:value={view.sort}><option value="observedMinutes">Минуты в чате</option><option value="estimatedChatMinutes">Оценка активности YouTube</option><option value="sessions">Частота посещений</option><option value="messages">Сообщения</option><option value="attendanceRatio">Доля посещённых эфиров</option></select></label><label class="check"><input type="checkbox" bind:checked={view.coreOnly} /> Только ядро</label></div>
    <div class="table-wrap compact-audience"><table class="compact-audience-table"><thead><tr><th>Участник</th><th>Посещаемость</th><th>Минуты в чате</th><th>Сообщения</th><th>Подробности</th></tr></thead><tbody>{#each visible.slice(0,data.audiencePage?100:200) as e (e.id)}<tr>
      <td class="audience-name" data-label="Участник"><div><button class={`text-button ${platformClass(e.sources??[e.source])}`} disabled={busy} onclick={()=>onPerson(e.id)}>{e.name}</button>{#if e.core}<span class="core-badge">Ядро</span>{:else if e.follower}<span class="follower-badge">Подписчик</span>{/if}{#each e.tags??[] as tag}<span class="person-tag">{tag}</span>{/each}</div><small>{(e.sources??[e.source]).map((source:string)=>source==='youtube'?'YouTube':source==='donationalerts'?'DA':'Twitch').join(' · ')}</small></td>
      <td class="audience-stat" data-label="Посещаемость">{Math.round((e.attendanceRatio??0)*100)}%</td><td class="audience-stat" data-label="Минуты в чате">{Math.round(e.observedMinutes).toLocaleString('ru-RU')}</td><td class="audience-stat" data-label="Сообщения">{e.messages}</td>
      <td class="audience-more"><button class="text-button small" aria-label={`Интервалы ${e.name}`} onclick={()=>selectEntity(e)}>Интервалы · {e.visits??e.intervals?.length??0}</button><details class="compact-details"><summary>Ещё</summary><dl><dt>Минут / посещённый эфир</dt><dd>{(e.observedMinutesPerSession??0).toFixed(1)}</dd><dt>YouTube · оценка, мин</dt><dd>{e.estimatedChatMinutes}</dd><dt>Часы появления</dt><dd>{(e.arrivalHours??[]).slice(0,3).map((h:any)=>`${h.day} ${h.hour}:00 (${h.visits})`).join(' · ')||'—'}</dd></dl></details></td>
    </tr>{/each}</tbody></table></div>
    {#if !visible.length}<p class="muted analytics-empty">Нет активности по выбранным фильтрам. Сначала нужны собранные эфиры.</p>{/if}
    {#if visible.length>200}<p class="small muted">Показаны первые 200; используйте поиск или меньший период.</p>{/if}
  {#if data.audiencePage}<div class="analytics-controls"><button class="outline" disabled={audienceBusy||audienceOffset===0} onclick={()=>audienceOffset=Math.max(0,audienceOffset-100)}>Предыдущие участники</button><span>{audienceBusy?'Загрузка…':`Страница ${Math.floor(audienceOffset/100)+1}`}</span><button class="outline" disabled={audienceBusy||audienceOffset+100>=(pagedAudience?.audiencePage?.total??data.audiencePage.total)} onclick={()=>audienceOffset+=100}>Следующие участники</button></div>{/if}
  </section>
  {/if}
{#if view.hours&&view.hourView!=="map"}<section class="panel hour-table"><details><summary>Таблица активности по дням и часам</summary><div class="table-wrap"><table class="analytics-table"><thead><tr><th>День / час ({timezone})</th><th>Выбранная метрика</th><th>Сообщения</th><th>Минут с опросами</th><th>Донатов/ч</th></tr></thead><tbody>{#each data.hours as h}<tr><td data-label="День / час">{h.day} · {h.hour}:00</td><td data-label="Выбранная метрика">{heatValue(h)===null?"нет данных":view.heatMetric==='amount'?money(String(Math.round(heatValue(h)!)),heatCurrency):heatValue(h)!.toFixed(1)}</td><td data-label="Сообщения">{h.messages}</td><td data-label="Минут с опросами">{h.observedKnownMinutes.toFixed(1)}</td><td data-label="Донатов/ч">{#each Object.entries(h.donationsPerHourMinor??{}) as [currency,amount]}<div>{amount===null?"—":money(String(amount),currency)}</div>{:else}—{/each}</td></tr>{/each}</tbody></table></div></details></section>{/if}
  <div class="analytics-secondary">
  {#if view.categories}<section class="panel"><header><h2>Категории</h2></header><div class="table-wrap"><table class="analytics-table"><thead><tr><th>Категория</th><th>Эфиры</th><th>Минуты эфира</th><th>Аудитория / ядро</th><th>Сообщений/ч</th><th>Донатов/ч</th><th>Наблюдаемых/мин с данными</th><th>Полнота опросов</th><th>Наблюдаемые / оценочные минуты</th></tr></thead><tbody>{#each data.categories.filter((c:any)=>c.id&&c.name!=="Категория неизвестна") as c}<tr><td data-label="Категория">{c.name}</td><td data-label="Эфиры">{c.sessions}</td><td data-label="Минуты эфира">{Math.round(c.minutes)}</td><td data-label="Аудитория / ядро">{c.audience} / {c.core}</td><td data-label="Сообщений/ч">{c.messagesPerHour.toFixed(1)}</td><td data-label="Донатов/ч">{#each Object.entries(c.donationsPerHourMinor??{}) as [currency,amount]}<div>{amount===null?"—":money(String(amount),currency)}</div>{:else}—{/each}</td><td data-label="Наблюдаемых/мин с данными">{c.observedPerKnownMinute==null?"нет данных":c.observedPerKnownMinute.toFixed(1)}</td><td data-label="Полнота опросов">{c.coverageRatio==null?"нет данных":Math.round(c.coverageRatio*100)+"%"}</td><td data-label="Наблюдаемые / оценочные минуты">{Math.round(c.observedMinutes)} / {Math.round(c.estimatedChatMinutes)}</td></tr>{/each}</tbody></table></div><div class="analytics-help"><Help id="analytics-categories" label="О сравнении категорий" text="Категории берутся только из Twitch. Неизвестная старая категория не восстанавливается догадкой. Сравнение показывает связи, а не причину роста аудитории."/></div></section>
  {/if}
  {#if view.streams&&data.streamComparison?.length}<section class="panel"><header><h2>Сравнение стримов</h2></header><div class="table-wrap"><table class="analytics-table"><thead><tr><th>Эфир</th><th>Категории</th><th>Аудитория</th><th>Ядро</th><th>Вернулись / впервые в периоде</th><th>Чатеры: уник. / пик / ср.</th><th>Twitch: ср. / пик</th><th>YouTube: ср. / пик</th><th>Данные зрителей: TW / YT</th><th>Сообщения</th><th>Сообщений/ч</th><th>Донатов/ч</th></tr></thead><tbody>{#each [...data.streamComparison].sort((a:any,b:any)=>b.startedAt-a.startedAt).slice(streamPage*100,(streamPage+1)*100) as stream}<tr><td data-label="Эфир"><button class="text-button" onclick={()=>{liveEnd=false;period='custom';from=localInput(stream.startedAt);to=localInput(stream.endedAt);}}>{date(stream.startedAt)}</button></td><td data-label="Категории">{stream.categories.filter((name:string)=>name!=="Категория неизвестна").join(" · ")||"—"}</td><td data-label="Аудитория">{stream.audience}</td><td data-label="Ядро">{stream.core}</td><td data-label="Вернулись / впервые в периоде">{stream.returning} / {stream.newInPeriod}</td><td data-label="Чатеры: уник. / пик / ср.">{stream.uniqueChatters} / {stream.peakChatters} / {stream.meanChatters===null?"—":stream.meanChatters.toFixed(1)}</td><td data-label="Twitch: ср. / пик">{stream.viewers.twitch.mean===null?"—":stream.viewers.twitch.mean.toFixed(1)} / {stream.viewers.twitch.peak??"—"}</td><td data-label="YouTube: ср. / пик">{stream.viewers.youtube.mean===null?"—":stream.viewers.youtube.mean.toFixed(1)} / {stream.viewers.youtube.peak??"—"}</td><td data-label="Данные зрителей: TW / YT">{Math.round((stream.viewers.twitch.coverageRatio??0)*100)}% / {Math.round((stream.viewers.youtube.coverageRatio??0)*100)}%</td><td data-label="Сообщения">{stream.messages}</td><td data-label="Сообщений/ч">{stream.messagesPerHour==null?"—":stream.messagesPerHour.toFixed(1)}</td><td data-label="Донатов/ч">{#each Object.entries(stream.donationsPerHourMinor??{}) as [currency,amount]}<div>{amount===null?"—":money(String(amount),currency)}</div>{:else}—{/each}</td></tr>{/each}</tbody></table></div><div class="analytics-controls"><button class="outline" disabled={streamPage===0} onclick={()=>streamPage--}>Назад</button><span>Страница {streamPage+1}</span><button class="outline" disabled={(streamPage+1)*100>=data.streamComparison.length} onclick={()=>streamPage++}>Далее</button></div><div class="analytics-help"><Help id="analytics-streams" label="О сравнении стримов" text="Возвращения считаются по аккаунтам среди более ранних эфиров в выбранном периоде. Нажмите дату, чтобы рассмотреть один эфир."/></div></section>{/if}
  {#if view.report&&data.youtubeReport&&!category}<YoutubeReport report={data.youtubeReport}/>{/if}
  </div>
  {#if selected}{#if detailBusy}<p class="small" role="status">Загружаем поминутные данные…</p>{/if}<section class="panel analytics-person"><header><h2>Активность: {selected.name}</h2><button class="outline" onclick={()=>selected=null}>Закрыть детализацию</button></header>
    <div class="settings-body"><p>Эфиров: {selected.sessionCount??selected.sessionIds.length} · Сообщений: {selected.messages} · Наблюдений: {selected.observedMinutes} мин · Оценка активности по чату: {selected.estimatedChatMinutes} мин</p>
      {#each Object.entries(selected.donations) as [currency,amount]}<p>Донаты с подтверждённым временем: {money(String(amount),currency)}</p>{/each}
      <button class="outline" onclick={()=>onPerson(selected.id)}>Открыть карточку человека</button>
      <label>Дата минутной сетки<input type="date" bind:value={day} /></label>
      <div class="analytics-minute-grid" aria-label="Минутная сетка активности">{#each detailMinutes as point}<span class={`minute-dot ${point.state}`} title={`${date(point.at)} — ${({observed:"наблюдался в опросе",estimated:"оценка после сообщения",not_observed:"не обнаружен в опросе",unknown:"нет данных"} as Record<string,string>)[point.state]}`}></span>{/each}</div>
      <Help id="analytics-minute-grid" label="О цветах минутной сетки" text="Бирюзовый — наблюдение, фиолетовый — оценка, светлый — отсутствовал в полном опросе, серый — неизвестно. Для YouTube отсутствие сообщения не означает уход."/>
      <div class="table-wrap"><table><thead><tr><th>Начало сигнала</th><th>Конец интервала</th><th>Тип</th></tr></thead><tbody>{#each [...(detailPerson?.intervals??[])].sort((a:any,b:any)=>b.from-a.from).slice(0,100) as span}<tr><td data-label="Начало сигнала">{date(span.from)}</td><td data-label="Конец интервала">{date(span.to)}</td><td data-label="Тип">{span.kind==="observed"?"Наблюдения Twitch":"Оценка по чату YouTube"}</td></tr>{/each}</tbody></table></div>
      <Help id="analytics-intervals" label="О границах интервалов" text={`${data.aggregate?"Показаны интервалы выбранного дня, до 100 строк.":"Показаны первые 100 интервалов."} Границы означают сигналы API с минутной детализацией, не доказанный вход/выход видеозрителя.`}/>
    </div>
  </section>{/if}
 </div>
{/if}

<style>.timing-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start}.timing-grid :global(.time-patterns){grid-column:1;grid-row:1}.timing-grid :global(.donation-patterns){grid-column:2;grid-row:1}.timing-grid :global(.discovery-grid){grid-column:1/-1}
@media(min-width:1101px){
 .timing-grid{grid-template-rows:repeat(6,auto) auto;row-gap:0;align-items:stretch}
 .timing-grid :global(.time-patterns),.timing-grid :global(.donation-patterns){display:grid;grid-template-rows:subgrid;grid-row:1/span 6;row-gap:0}
 .timing-grid :global(.time-patterns>header),.timing-grid :global(.donation-patterns>header){grid-row:1}
 .timing-grid :global(.chart-category){grid-row:2}
 .timing-grid :global(.pattern-controls),.timing-grid :global(.donation-patterns>.controls){grid-row:3;align-content:start;padding:16px 20px}
 .timing-grid :global(.pattern-note){grid-row:4;margin:0;padding:0 20px 8px}
 .timing-grid :global(.pattern-bars),.timing-grid :global(.donation-patterns>.bars){grid-row:5;grid-auto-rows:28px;align-content:start;gap:6px;padding:8px 20px 16px}
 .timing-grid :global(.pattern-row),.timing-grid :global(.bar-row){min-height:0;align-items:center}
 .timing-grid :global(.donation-patterns>.note){grid-row:6;margin:0;padding:0 20px 16px}
 .timing-grid :global(.discovery-grid){grid-row:7;margin-top:16px}
}
@media(max-width:1100px){.timing-grid{grid-template-columns:minmax(0,1fr)}.timing-grid :global(.time-patterns),.timing-grid :global(.donation-patterns){grid-column:auto;grid-row:auto}}.report-pending :global(.hour-heatmap),.report-pending :global(.clock-plot),.report-pending :global(.clock-caption),.report-pending :global(.time-audience),.report-pending :global(.pattern-bars),.report-pending :global(.bars),.report-pending :global(.compact-audience),.report-pending :global(.comparison-bars),.report-pending :global(.growth-plot),.report-pending :global(.regular-summary),.report-pending :global(.composition-bar),.report-pending :global(.composition-row),.report-pending :global(.table-wrap),.report-pending :global(.donation-patterns header>span){visibility:hidden}.chart-refresh{margin:8px 0 0}.chart-category{padding:10px 16px 0}.chart-category label{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--muted)}.chart-category select{width:auto;max-width:100%;min-width:0;padding:6px 10px;font-size:12px;flex:1}.analytics-category-filter{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:10px 16px;margin-bottom:16px;background:var(--panel,#12161e);border:1px solid var(--border);border-radius:10px}.analytics-category-filter label{display:flex;align-items:center;gap:10px;font-size:12px}.analytics-category-filter select{max-width:240px;padding:7px 10px}.analytics-category-filter>span{flex:1;min-width:160px;font-size:11px}@media(max-width:600px){.analytics-filter .analytics-controls .analytics-date{grid-column:1/-1}.analytics-category-filter label{flex:1}.analytics-category-filter select{flex:1;min-width:0;max-width:100%}.analytics-category-filter>span{display:none}}.compact-audience{max-height:560px;overflow:auto}.compact-audience-table{width:100%;border-collapse:collapse;min-width:620px}.compact-audience-table td,.compact-audience-table th{padding:12px;text-align:left;border-bottom:1px solid var(--border);font-size:12px}.hour-table summary{padding:16px 20px;font-weight:600;cursor:pointer}.hour-table .table-wrap{max-height:440px;overflow:auto}.twitch{color:var(--twitch,#a970ff)!important}.youtube{color:var(--youtube,#ff5959)!important}.analytics-help{padding:0 20px 12px;}header h2{display:flex;align-items:center;gap:8px;}
</style>
