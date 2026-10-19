<script lang="ts">
 import type {Snippet} from 'svelte';
 import Help from './Help.svelte';
 import {money} from './api';
 let {categoryFilter,data}:{categoryFilter:Snippet<[string]>;data:any}=$props();
 let dimension=$state('weekday'),metric=$state('viewers'),calculation=$state('average'),currency=$state('RUB');
 const days=['пн','вт','ср','чт','пт','сб','вс'];
 const currencies=$derived([...new Set<string>((data.hours??[]).flatMap((h:any)=>Object.keys(h.donationTotals)))]);
 const available=$derived(currencies.includes(currency)?currency:currencies[0]??'RUB');
 const rows=$derived((dimension==='weekday'?days:Array.from({length:24},(_,i)=>i)).map(key=>({label:dimension==='weekday'?String(key):`${key}:00`,cell:(dimension==='weekday'?data.patterns.byWeekday:data.patterns.byHour).find((c:any)=>dimension==='weekday'?c.day===key:c.hour===key)})));
 function value(c:any):number|null{
  if(!c||!c.sampleMinutes)return null;
  if(metric==='viewers'){const samples=c.knownViewerSamples??c.viewerSamples,total=c.knownViewersTotal??c.viewersTotal;return samples?(calculation==='average'?total/samples:total):null;}
  if(metric==='observed')return calculation==='average'?c.observedMean:c.observedKnownMinutes?c.observed:null;
  if(metric==='estimated')return calculation==='average'?c.estimatedMean:c.estimated;
  if(metric==='messages')return calculation==='average'?c.messagesPerHour:c.messages;
  if(metric==='donations')return calculation==='average'?c.donationsPerHour:c.donationCount;
  return Number((calculation==='average'?c.donationsPerHourMinor:c.donationTotals)[available]??'0');
 }
 const maximum=$derived(Math.max(1,...rows.map(row=>value(row.cell)??0)));
 const units=$derived(metric==='amount'?`${available}${calculation==='average'?'/ч':''}`:calculation==='average'?['messages','donations'].includes(metric)?'в час эфира':'в среднем':metric==='viewers'?'зритель·мин':['observed','estimated'].includes(metric)?'человек·мин':'всего');
 const format=(n:number|null)=>n===null?'Нет данных':metric==='amount'?money(String(Math.round(n)),available):n.toLocaleString('ru-RU',{maximumFractionDigits:1});
 const groups=$derived([{label:'Ядро',count:data.composition.core,color:'#e4c568'},{label:'Подписчики вне ядра',count:data.composition.followers,color:'#9b86dc'},{label:'Не подписаны',count:data.composition.nonFollowers,color:'#5fc4aa'},{label:'Статус неизвестен',count:data.composition.unknown,color:'#666f80'}]);
 const total=$derived(groups.reduce((n,g)=>n+g.count,0));

</script>
<section class="panel time-patterns"><header><h2>Когда стримить</h2><Help id="time-pattern-help" label="Как считаются средние" text="Средние взвешены по длительности с данными. Часы без эфиров не считаются нулями. Накопленная сумма складывает всю активность выбранного периода."/></header>{@render categoryFilter("Категория времени эфиров")}
 <div class="pattern-controls">
  <label>Сравнение времени<select aria-label="Сравнение времени" bind:value={dimension}><option value="weekday">Дни недели</option><option value="hour">Время суток</option></select></label>
  <label>Показатель времени<select aria-label="Показатель времени" bind:value={metric}><option value="viewers">Зрители</option><option value="messages">Сообщения</option><option value="observed">Участники Twitch</option><option value="estimated">Активность YouTube · оценка</option><option value="donations">Число донатов</option><option value="amount">Сумма донатов</option></select></label>
  <label>Расчёт времени<select aria-label="Расчёт времени" bind:value={calculation}><option value="average">Среднее / на час эфира</option><option value="total">Накопленная сумма</option></select></label>
  {#if metric==='amount'}<label>Валюта времени<select aria-label="Валюта времени" bind:value={currency}>{#each currencies as c}<option value={c}>{c}</option>{:else}<option value="RUB">RUB</option>{/each}</select></label>{/if}
 </div>
 <p class="small muted pattern-note">{units}{metric==='viewers'&&rows.some(row=>row.cell?.viewerPartialMinutes)?' · ≥ — неполные данные площадок':''}</p>
 <div class="pattern-bars" aria-label="Сравнение дней и часов">{#each rows as row}<div class="pattern-row"><span>{row.label}</span><div class="pattern-track" class:no-data={value(row.cell)===null}><i style:width={`${(value(row.cell)??0)/maximum*100}%`}></i></div><strong>{metric==='viewers'&&row.cell?.viewerPartialMinutes?'≥ ':''}{format(value(row.cell))}</strong><small>{row.cell?`${Math.round(row.cell.sampleMinutes)} мин эфира`:''}</small></div>{/each}</div>
</section>
<div class="discovery-grid">
 <section class="panel audience-composition"><header><h2>Состав аудитории</h2><Help id="composition-help" label="О составе аудитории" text={`Известные участники: Twitch ${data.composition.twitch}, YouTube ${data.composition.youtube}, связаны на обеих площадках ${data.composition.both}. Человек учитывается один раз. Статус подписки — на последнюю проверку. Анонимные зрители в счётчиках не раскрывают аккаунт. Неизвестный статус не означает отсутствие подписки.`}/></header>{@render categoryFilter("Категория состава аудитории")}<div class="settings-body">
  <div class="composition-bar" aria-label="Доли состава аудитории">{#each groups as g}<span style:width={`${total?g.count/total*100:0}%`} style:background={g.color}></span>{/each}</div>
  {#each groups as g}<p class="composition-row"><span><i style:background={g.color}></i>{g.label}</span><strong>{g.count}{total?` · ${Math.round(g.count/total*100)}%`:''}</strong></p>{/each}
 </div></section>

</div>
<style>
 .pattern-controls{display:flex;flex-wrap:wrap;gap:12px;padding:16px;}label{display:grid;gap:6px;font-size:12px;flex:1 1 160px;}select{width:100%;min-width:0;}.pattern-note{padding:0 16px;}.pattern-bars{padding:12px 16px;display:grid;gap:10px;}.pattern-row{display:grid;grid-template-columns:38px minmax(30px,1fr) 110px 86px;gap:10px;align-items:center;font-size:12px;}.pattern-row strong{text-align:right;font-size:12px;}.pattern-row small{color:var(--muted);text-align:right;}.pattern-track{height:8px;background:#242a34;border-radius:4px;overflow:hidden;}.pattern-track i{display:block;height:100%;background:var(--teal);}.no-data{background:#20242d;}.discovery-grid{display:grid;grid-template-columns:1fr;gap:16px;}.composition-bar{display:flex;height:12px;border-radius:6px;overflow:hidden;margin-bottom:18px;background:#242a34;}.composition-row{display:flex;justify-content:space-between;gap:12px;font-size:13px;}.composition-row span{display:flex;align-items:center;gap:8px;}.composition-row i{display:inline-block;width:8px;height:8px;border-radius:50%;}.composition-row strong{white-space:nowrap;}.settings-body{padding:16px;}
 @media(max-width:900px){.discovery-grid{grid-template-columns:1fr;gap:0;}}
 @media(max-width:480px){.pattern-row{grid-template-columns:28px minmax(24px,1fr) 72px;gap:8px;}.pattern-row strong{font-size:11px;}.pattern-row small{grid-column:2 / -1;margin-top:-7px;font-size:10px;}.composition-row{font-size:12px;}}
</style>
