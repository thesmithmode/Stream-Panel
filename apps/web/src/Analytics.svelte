<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { api, date, money, getDataMode } from "./api";
  import TrendChart from "./TrendChart.svelte";
  let { profile = "local", mode = "real", onPerson }: {profile?:string;mode?:string;onPerson:(id:string)=>void} = $props();
  const localInput=(at:number)=>{const d=new Date(at);return new Date(at-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
  let from=$state(localInput(Date.now()-30*86400000)),to=$state(localInput(Date.now())),source=$state("all"),category=$state("");
  let minSessions=$state(3),minMinutes=$state(30),minMessages=$state(5),coreRule=$state("either"),chatWindowMinutes=$state(5),timezone=$state("Europe/Moscow");
  let coreOnly=$state(false),search=$state(""),sort=$state("observedMinutes"),metric=$state("observed"),data=$state<any>(null),error=$state(""),busy=$state(false),selected=$state<any>(null),day=$state("");
  let requestId=0, mounted=$state(false);
  $effect(()=>{mode;if(mounted)untrack(()=>void refresh());});
  const visible=$derived((data?.audience??[]).filter((e:any)=>(!coreOnly||e.core)&&e.name.toLowerCase().includes(search.toLowerCase())).sort((a:any,b:any)=>sort==="sessions"?b.sessionIds.length-a.sessionIds.length:(b[sort]??0)-(a[sort]??0)));
  const weekdays=["пн","вт","ср","чт","пт","сб","вс"];
  const hourCells=$derived(new Map((data?.hours??[]).map((h:any)=>[`${h.day}:${h.hour}`,h])) as Map<string,any>);
  const hourMax=$derived(Math.max(1,...(data?.hours??[]).filter((h:any)=>h.observedKnownMinutes).map((h:any)=>h.observed/h.observedKnownMinutes)));
  function hourTitle(day:string,hour:number){const cell=hourCells.get(`${day}:${hour}`);return `${day} ${hour}:00 — ${cell?.observedKnownMinutes?(cell.observed/cell.observedKnownMinutes).toFixed(1)+" наблюдаемых в среднем":"нет опросов"}`;}
  const categoryOptions=$derived(data?.availableCategories??data?.categories??[]);
  const detailMinutes=$derived.by(()=>{
    if(!selected||!day)return [];
    const start=new Date(`${day}T00:00:00`).getTime();
    return Array.from({length:1440},(_,i)=>{
      const at=start+i*60000,span=selected.intervals.find((s:any)=>s.from<at+60000&&s.to>at),known=data.timeline.find((p:any)=>p.at===at)?.presenceKnown;
      return {at,state:span?.kind==="chat_proxy"?"estimated":span?"observed":selected.source==="twitch"&&known?"not_observed":"unknown"};
    });
  });
  function selectEntity(e:any){selected=e;day=localInput(e.intervals.at(-1)?.from??new Date(to).getTime()).slice(0,10);}
  function preset(days:number){from=localInput(Date.now()-days*86400000);to=localInput(Date.now());void refresh();}
  async function refresh(){
    const id=++requestId;busy=true;error="";
    const filter={fromMs:new Date(from).getTime(),toMs:new Date(to).getTime(),source,category,minSessions,minMinutes,minMessages,coreRule,chatWindowMinutes,timezone};
    try{
      try {localStorage.setItem(`sp-analytics-${profile}`,JSON.stringify({minSessions,minMinutes,minMessages,coreRule,chatWindowMinutes,timezone}));}catch{/* optional local preferences */}
      const q=new URLSearchParams({from:String(filter.fromMs),to:String(filter.toMs),source,category,minSessions:String(minSessions),minMinutes:String(minMinutes),minMessages:String(minMessages),coreRule,chatWindowMinutes:String(chatWindowMinutes),timezone});
      const result=await api(`analytics?${q}`);
      if(id===requestId){data=result;selected=null;}
    }catch(e){if(id===requestId){error=(e as Error).message;data=null;selected=null;}}
    finally{if(id===requestId)busy=false;}
  }
  onMount(()=>{
    try{const saved=JSON.parse(localStorage.getItem(`sp-analytics-${profile}`)??"null");if(saved){minSessions=saved.minSessions??3;minMinutes=saved.minMinutes??30;minMessages=saved.minMessages??5;coreRule=saved.coreRule??"either";chatWindowMinutes=saved.chatWindowMinutes??5;timezone=saved.timezone??"Europe/Moscow";}}catch{/* private browser may deny storage */}
    mounted=true;return ()=>{requestId++;};
  });
</script>
<section class="panel analytics-filter">
  <header><h2>Настройки аналитики</h2><div class="actions"><button class="outline small" onclick={()=>preset(7)}>7 дней</button><button class="outline small" onclick={()=>preset(30)}>30 дней</button><button class="outline small" onclick={()=>preset(90)}>90 дней</button></div></header>
  <form class="analytics-controls" onsubmit={(e)=>{e.preventDefault();void refresh();}}>
    <label>Начало периода<input type="datetime-local" bind:value={from} required /></label>
    <label>Конец периода<input type="datetime-local" bind:value={to} required /></label>
    <label>Площадка<select bind:value={source}><option value="all">Все площадки</option><option value="twitch">Twitch / DA</option><option value="youtube">YouTube</option></select></label>
    <label>Категория Twitch<select bind:value={category}><option value="">Все категории</option>{#each categoryOptions.filter((c:any)=>c.id) as c}<option value={c.id}>{c.name}</option>{/each}</select></label>
    <label>Часовой пояс сравнения<select bind:value={timezone}><option value="Europe/Moscow">Москва</option><option value="UTC">UTC</option><option value="Asia/Yekaterinburg">Екатеринбург</option></select></label>
    <details class="analytics-thresholds"><summary>Как определять ядро аудитории</summary><div class="analytics-controls">
      <label>Минимум эфиров<input type="number" min="1" max="1000" bind:value={minSessions} /></label>
      <label>Минимум минут активности<input type="number" min="0" max="129600" bind:value={minMinutes} /></label>
      <label>Минимум сообщений<input type="number" min="0" max="1000000" bind:value={minMessages} /></label>
      <label>Правило ядра<select bind:value={coreRule}><option value="either">Часто + долго или много сообщений</option><option value="both">Часто + долго + много сообщений</option><option value="frequency">Только частота возвращений</option></select></label>
      <label>Окно активности YouTube, мин<input type="number" min="1" max="30" bind:value={chatWindowMinutes} /></label>
    </div></details>
    <button class="primary" type="submit" disabled={busy}>{busy?"Считаем…":"Применить"}</button>
  </form>
  <p class="small muted">Даты — в часовом поясе браузера. Ядро требует заданного числа эфиров и выбранного правила. Владельцы каналов и боты исключены из персональных расчётов; исходные события сохранены.</p>
</section>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if data}
  <section class="metrics">
    <div class="metric"><div><span>Профили аудитории</span><strong>{data.summary.entities}</strong><small>Аккаунты YouTube отдельно от людей Twitch/DA</small></div></div>
    <div class="metric"><div><span>Ядро аудитории</span><strong>{data.summary.core}</strong><small>По выбранным порогам</small></div></div>
    <div class="metric"><div><span>Эфиры / сообщения</span><strong>{data.summary.streams} / {data.summary.messages}</strong></div></div>
  </section>
  <section class="panel analytics-chart"><header><h2>Активность по времени</h2><label>Метрика графика<select bind:value={metric}><option value="observed">Наблюдаемые участники Twitch</option><option value="estimated">Оценка активности YouTube</option><option value="messages">Сообщения</option><option value="viewers">Счётчик зрителей площадки</option></select></label></header>
    <TrendChart points={data.timeline} {metric} />
    <p class="small muted">Twitch — присутствие в опросах чата. YouTube — окно после сообщения, оценка, а не время просмотра. Серые отметки — неизвестные данные. Счётчик площадки агрегатный, персональные исключения к нему неприменимы.</p>
  </section>
  <section class="panel"><header><h2>Что стримить: категории</h2></header><div class="table-wrap"><table class="analytics-table"><thead><tr><th>Категория</th><th>Эфиры</th><th>Минуты эфира</th><th>Аудитория / ядро</th><th>Сообщений/ч</th><th>Наблюдаемых/мин эфира</th><th>Наблюдаемые / оценочные минуты</th></tr></thead><tbody>{#each data.categories as c}<tr><td>{c.name}</td><td>{c.sessions}</td><td>{Math.round(c.minutes)}</td><td>{c.audience} / {c.core}</td><td>{c.messagesPerHour.toFixed(1)}</td><td>{(c.observedPerMinute??0).toFixed(1)}</td><td>{Math.round(c.observedMinutes)} / {Math.round(c.estimatedChatMinutes)}</td></tr>{/each}</tbody></table></div><p class="small muted">Категории берутся только из Twitch. Неизвестная старая категория не восстанавливается догадкой. Сравнение показывает связи, а не причину роста аудитории.</p></section>
  <section class="panel"><header><h2>Когда стримить: дни и часы</h2></header>
    <div class="hour-heatmap" aria-label="Карта активности по дням и часам">
      <div class="heatmap-labels"><span></span>{#each Array.from({length:24},(_,i)=>i) as hour}<span>{hour}</span>{/each}</div>
      {#each weekdays as weekday}<div class="heatmap-row"><strong>{weekday}</strong>{#each Array.from({length:24},(_,i)=>i) as hour}<span title={hourTitle(weekday,hour)} style:background={hourCells.get(`${weekday}:${hour}`)?.observedKnownMinutes?`rgba(95,196,170,${.15+.85*hourCells.get(`${weekday}:${hour}`).observed/hourCells.get(`${weekday}:${hour}`).observedKnownMinutes/hourMax})`:"#3b4350"}></span>{/each}</div>{/each}
    </div><p class="small muted">Яркость — среднее число наблюдаемых участников Twitch среди минут с успешными опросами. Серый — нет данных; это не нулевая аудитория.</p><div class="table-wrap"><table class="analytics-table"><thead><tr><th>День / час ({timezone})</th><th>Среднее наблюдаемых участников</th><th>Сообщения</th><th>Минут с опросами</th></tr></thead><tbody>{#each data.hours as h}<tr><td>{h.day} · {h.hour}:00</td><td>{h.observedKnownMinutes?(h.observed/h.observedKnownMinutes).toFixed(1):"нет данных"}</td><td>{h.messages}</td><td>{h.observedKnownMinutes}</td></tr>{/each}</tbody></table></div></section>
  {#if data.streamComparison?.length}<section class="panel"><header><h2>Возвращения по эфирам</h2></header><div class="table-wrap"><table class="analytics-table"><thead><tr><th>Эфир</th><th>Категории</th><th>Аудитория</th><th>Ядро</th><th>Вернулись / впервые в периоде</th><th>Сообщения</th></tr></thead><tbody>{#each data.streamComparison as stream}<tr><td><button class="text-button" onclick={()=>{from=localInput(stream.startedAt);to=localInput(stream.endedAt);void refresh();}}>{date(stream.startedAt)}</button></td><td>{stream.categories.join(" → ")}</td><td>{stream.audience}</td><td>{stream.core}</td><td>{stream.returning} / {stream.newInPeriod}</td><td>{stream.messages}</td></tr>{/each}</tbody></table></div><p class="small muted">Возвращения считаются по аккаунтам среди более ранних эфиров в выбранном периоде. Нажмите дату, чтобы рассмотреть один эфир.</p></section>{/if}
  <section class="panel"><header><h2>Состав аудитории</h2><span>{visible.length} профилей</span></header>
    <div class="analytics-controls"><label>Поиск участника<input bind:value={search} placeholder="Имя" /></label><label>Сортировка<select bind:value={sort}><option value="observedMinutes">Наблюдаемые минуты</option><option value="estimatedChatMinutes">Оценка активности YouTube</option><option value="sessions">Частота посещений</option><option value="messages">Сообщения</option></select></label><label class="check"><input type="checkbox" bind:checked={coreOnly} /> Только ядро</label></div>
    <div class="table-wrap"><table class="analytics-table"><thead><tr><th>Участник</th><th>Площадка</th><th>Эфиры</th><th>Минуты наблюдений</th><th>Оценка YouTube, мин</th><th>Сообщения</th><th>Сегменты активности</th></tr></thead><tbody>{#each visible.slice(0,200) as e}<tr><td><button class="text-button" onclick={()=>selectEntity(e)}>{e.name}</button>{#if e.core}<span class="core-badge">Ядро</span>{/if}</td><td>{e.source==="youtube"?"YouTube":"Twitch / DA"}</td><td>{e.sessionIds.length}</td><td>{e.observedMinutes}</td><td>{e.estimatedChatMinutes}</td><td>{e.messages}</td><td>{e.visits}</td></tr>{/each}</tbody></table></div>
    {#if !visible.length}<p class="muted analytics-empty">Нет активности по выбранным фильтрам. Сначала нужны собранные эфиры.</p>{/if}
    {#if visible.length>200}<p class="small muted">Показаны первые 200; используйте поиск или меньший период.</p>{/if}
  </section>
  {#if selected}<section class="panel analytics-person"><header><h2>Активность: {selected.name}</h2><button class="outline" onclick={()=>selected=null}>Закрыть детализацию</button></header>
    <div class="settings-body"><p>Эфиров: {selected.sessionIds.length} · Сообщений: {selected.messages} · Наблюдений: {selected.observedMinutes} мин · Оценка активности по чату: {selected.estimatedChatMinutes} мин</p>
      {#each Object.entries(selected.donations) as [currency,amount]}<p>Донаты с подтверждённым временем: {money(String(amount),currency)}</p>{/each}
      {#if selected.source==="twitch"}<button class="outline" onclick={()=>onPerson(selected.id)}>Открыть карточку человека</button>{/if}
      <label>Дата минутной сетки<input type="date" bind:value={day} /></label>
      <div class="analytics-minute-grid" aria-label="Минутная сетка активности">{#each detailMinutes as point}<span class={`minute-dot ${point.state}`} title={`${date(point.at)} — ${({observed:"наблюдался в опросе",estimated:"оценка после сообщения",not_observed:"не обнаружен в опросе",unknown:"нет данных"} as Record<string,string>)[point.state]}`}></span>{/each}</div>
      <p class="small muted">Бирюзовый — наблюдение, фиолетовый — оценка, светлый — отсутствовал в полном опросе, серый — неизвестно. Для YouTube отсутствие сообщения не означает уход.</p>
      <div class="table-wrap"><table><thead><tr><th>Начало сигнала</th><th>Конец интервала</th><th>Тип</th></tr></thead><tbody>{#each selected.intervals.slice(0,100) as span}<tr><td>{date(span.from)}</td><td>{date(span.to)}</td><td>{span.kind==="observed"?"Наблюдения Twitch":"Оценка по чату YouTube"}</td></tr>{/each}</tbody></table></div>
      <p class="small muted">Показаны первые 100 интервалов. Границы означают сигналы API с минутной детализацией, не доказанный вход/выход видеозрителя.</p>
    </div>
  </section>{/if}
{/if}
