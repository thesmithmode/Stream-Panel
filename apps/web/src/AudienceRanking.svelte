<script lang="ts">
 import Help from './Help.svelte';
 import Icon from './Icon.svelte';
 import {platformClass} from './period';
 import {type RankPerson,presenceMinutes,rankTable,intervalRows,durationLabel} from './audience-ranking';
 import {intervalRange} from './stream-time';
 import {money} from './api';
 let {people,onPerson,showIntervals=false,streamStart=0,streamEnd=0}:{people:RankPerson[];onPerson:(id:string)=>void;showIntervals?:boolean;streamStart?:number;streamEnd?:number}=$props();
 const id=$props.id();
 let metric=$state('presence'),descending=$state(true),limit=$state(50),expanded=$state(new Set<string>()),viewport=$state(1024);
 const currencies=$derived([...new Set(people.flatMap(p=>Object.keys(p.donations??{})))].sort());
 const ranked=$derived(rankTable(people,metric,descending));
 const currencyColumns=$derived(viewport<=720?[]:currencies);
 $effect(()=>{void metric;limit=50;});
 $effect(()=>{void streamStart;limit=50;expanded=new Set();});
 function sort(key:string){if(metric===key)descending=!descending;else{metric=key;descending=true;}}
 function toggle(personId:string){const next=new Set(expanded);if(next.has(personId))next.delete(personId);else next.add(personId);expanded=next;}
 const arrow=(key:string)=>metric===key?(descending?' ↓':' ↑'):'';
 const groups=(person:RankPerson)=>{
  const rows=intervalRows(person.intervals??[]);
  return [...new Set(rows.map(span=>span.kind))].map(kind=>rows.filter(span=>span.kind===kind));
 };
 const source=(kind:string)=>kind==='observed'?'Twitch':'YouTube · оценка';
</script>
<svelte:window bind:innerWidth={viewport}/>
<section class="panel audience-ranking" aria-label="Рейтинг участников">
 <header><h2>Участники чата</h2><Help id={`${id}-help`} label="О времени участников" text="Время в эфире объединяет интервалы Twitch и YouTube без двойного подсчёта пересечений. Twitch — наблюдаемое присутствие в чате, YouTube — оценка по сообщениям. Площадки не раскрывают персональное время просмотра видео. Нажмите время или стрелку рядом, чтобы раскрыть интервалы. Пауза означает отсутствие сохранённых сигналов площадки, а не подтверждённый уход зрителя. Среднее число участников считается по всей длительности эфира; пропуски наблюдений могут его занижать."/></header>
 {#if currencies.length}<div class="phone-donation-sort" aria-label="Сортировка по донатам">{#each currencies as currency}<button class="text-button" aria-label={`Донаты, ${currency}${arrow(`donation:${currency}`)}`} aria-pressed={metric===`donation:${currency}`} onclick={()=>sort(`donation:${currency}`)}>Донаты · {currency}{arrow(`donation:${currency}`)}</button>{/each}</div>{/if}
 <div class="table-scroll"><table>
  <thead><tr>
   <th scope="col" aria-sort={metric==='name'?(descending?'descending':'ascending'):'none'}><button onclick={()=>sort('name')}>Участник{arrow('name')}</button></th>
   <th scope="col" class:with-disclosure={showIntervals} aria-sort={metric==='presence'?(descending?'descending':'ascending'):'none'}><button aria-label={`Время в чате${arrow('presence')}`} onclick={()=>sort('presence')}><span class="desktop-label">Время в чате</span><span class="phone-label">В чате</span>{arrow('presence')}</button></th>
   <th scope="col" aria-sort={metric==='messages'?(descending?'descending':'ascending'):'none'}><button aria-label={`Сообщения${arrow('messages')}`} onclick={()=>sort('messages')}><span class="desktop-label">Сообщения</span><span class="phone-label">Сообщ.</span>{arrow('messages')}</button></th>
   {#each currencyColumns as currency}<th scope="col" class="donation-column" aria-sort={metric===`donation:${currency}`?(descending?'descending':'ascending'):'none'}><button onclick={()=>sort(`donation:${currency}`)}>Донаты, {currency}{arrow(`donation:${currency}`)}</button></th>{/each}
  </tr></thead>
  <tbody>{#each ranked.slice(0,limit) as person (person.id)}
   {@const regionId=`${id}-intervals-${person.id}`}
   {@const hasIntervals=showIntervals&&!!person.intervals?.length}
   <tr class="participant-row" class:expanded={expanded.has(person.id)&&hasIntervals}>
    <td><button class={`text-button person-name ${platformClass(person.accounts?.map(a=>a.source))}`} title={person.name} onclick={()=>onPerson(person.id)}>{person.name}</button>
     {#if currencies.some(c=>BigInt(person.donations?.[c]??'0')!==0n)}<div class="phone-donations">{#each currencies as c}{#if BigInt(person.donations?.[c]??'0')!==0n}<span>{money(person.donations![c]!,c)}</span>{/if}{/each}</div>{/if}
    </td>
    <td class:with-disclosure={showIntervals}>{#if hasIntervals}<button class="interval-toggle" aria-label={`Интервалы ${person.name}`} aria-expanded={expanded.has(person.id)} aria-controls={expanded.has(person.id)?regionId:undefined} onclick={()=>toggle(person.id)}><strong>{durationLabel(presenceMinutes(person))}</strong><Icon name="arrow" size={14}/></button>{:else}<strong class="plain-duration">{durationLabel(presenceMinutes(person))}</strong>{/if}</td>
    <td class="message-count">{person.messages??0}</td>
    {#each currencyColumns as currency}<td class="donation-column">{BigInt(person.donations?.[currency]??'0')===0n?'—':money(person.donations![currency]!,currency)}</td>{/each}
   </tr>
   {#if hasIntervals&&expanded.has(person.id)}<tr class="interval-detail"><td colspan={3+currencyColumns.length}>
    <div id={regionId} role="region" aria-label={`Интервалы ${person.name}`} class="interval-list">
     {#each groups(person) as spans}
      <ul class="platform-intervals">
       {#each spans as span,index}
        <li class="interval-row">
         <small class="interval-source" class:twitch={span.kind==='observed'} class:youtube={span.kind!=='observed'} class:repeated={index>0}><span class="desktop-label">{source(span.kind)}</span><span class="phone-label">{span.kind==='observed'?'Twitch':'YT · оценка'}</span></small>
         <span class="interval-range">{intervalRange(span.from,span.to,streamStart,streamEnd)}</span>
         <strong>{durationLabel((span.to-span.from)/60000)}{#if span.gap>0}<span class="phone-gap" title={`Пауза ${source(span.kind)} · ${durationLabel(span.gap/60000)}`}> · пауза {durationLabel(span.gap/60000).replaceAll(' мин','м').replaceAll(' ч','ч')}</span>{/if}</strong>
         {#if span.gap>0}<span class="interval-gap" title="Промежуток без сохранённых сигналов площадки">Пауза {span.kind==='observed'?'Twitch':'YouTube'} · {durationLabel(span.gap/60000)}</span>{/if}
        </li>
       {/each}
      </ul>
     {/each}
    </div>
   </td></tr>{/if}
  {:else}<tr><td colspan={3+currencyColumns.length} class="muted empty-ranking">Нет сохранённых данных об участниках</td></tr>{/each}</tbody>
 </table></div>
 {#if ranked.length>limit}<button class="outline small more" onclick={()=>limit+=50}>Показать ещё ({ranked.length-limit})</button>{/if}
</section>
<style>
 header{gap:12px;}h2{margin-right:auto;}
 .table-scroll{overflow-x:auto;max-width:100%;}table{width:100%;border-collapse:collapse;}
 th,td{padding:4px 12px;border-bottom:1px solid var(--border);text-align:right;vertical-align:middle;}
 th:first-child,td:first-child{text-align:left;}th:first-child{width:46%;}
 th{font-size:12px;color:var(--muted);white-space:nowrap;font-weight:400;}
 th button{background:none;border:0;color:inherit;font:inherit;cursor:pointer;padding:0;min-height:44px;}
 td{font-size:13px;white-space:nowrap;font-variant-numeric:tabular-nums;}
 .person-name{display:block;max-width:100%;min-height:44px;font-size:14px;text-align:left;white-space:normal;overflow-wrap:anywhere;}
 .twitch{color:var(--twitch,#a970ff)!important;}.youtube{color:var(--youtube,#ff5959)!important;}
 .interval-toggle{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-height:44px;width:100%;padding:0;border:0;background:none;font:inherit;color:var(--text);white-space:nowrap;}
 .interval-toggle :global(svg){transform:rotate(90deg);color:var(--muted);flex-shrink:0;}
 .interval-toggle[aria-expanded=true] :global(svg){transform:rotate(-90deg);color:var(--accent);}
 .plain-duration{display:block;padding-block:12px;}.expanded>td{border-bottom:0;}
 .interval-detail>td{padding:0 12px 8px;white-space:normal;}
 th.with-disclosure button{margin-right:22px;}
 td.with-disclosure .plain-duration{padding-right:22px;}
 .interval-list{padding:2px 0;display:grid;gap:2px;}
 .platform-intervals{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;align-items:center;gap:2px 16px;}
 .interval-row{display:flex;align-items:baseline;gap:10px;min-height:26px;font-size:12px;}
 .interval-source{width:116px;flex:none;font-size:11px;white-space:nowrap;}
 .interval-source.repeated{display:none;}
 .interval-range,.interval-row>strong{white-space:nowrap;}
 .interval-row>strong{font-size:12px;font-weight:500;}
 .phone-gap{display:none;}
 .interval-gap{color:var(--muted);font-size:10px;white-space:nowrap;}
 @media(min-width:721px){.interval-row:has(.interval-gap) .interval-gap{order:-1;}.interval-row:has(.interval-gap) .interval-source{order:-2;}}
 .more{margin:12px;}.empty-ranking{padding:16px;white-space:normal;}
 .phone-label,.phone-donations,.phone-donation-sort{display:none;}
 @media(max-width:720px){
  table{table-layout:fixed;}.desktop-label,.donation-column{display:none;}.phone-label{display:inline;}
  th,td{padding:4px 8px;}th:first-child{width:auto;}th:nth-child(2){width:106px;}th:nth-child(3){width:62px;}
  .person-name{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .interval-toggle{gap:5px;font-size:12px;}.interval-toggle strong,.plain-duration{font-weight:500;font-size:12px;}
  .message-count{font-size:13px;white-space:normal;overflow-wrap:anywhere;}.phone-donations{display:flex;gap:4px 8px;flex-wrap:wrap;color:var(--muted);font-size:11px;padding-bottom:4px;white-space:normal;overflow-wrap:anywhere;}
  .phone-donation-sort{display:flex;gap:4px 12px;flex-wrap:wrap;padding:0 12px 4px;}.phone-donation-sort button{min-height:36px;font-size:12px;}.phone-donation-sort button[aria-pressed=true]{color:var(--accent);}
  .interval-detail>td{padding:0 8px 6px;}
  th.with-disclosure button{margin-right:19px;}td.with-disclosure .plain-duration{padding-right:19px;}
  .platform-intervals{display:grid;gap:0;}
  .interval-row{display:grid;grid-template-columns:76px minmax(0,1fr) auto;gap:2px 7px;min-height:28px;font-size:11px;align-items:baseline;}
  .interval-source{width:auto;font-size:10px;}.interval-source.repeated{display:block;}
  .interval-row>strong{font-size:11px;text-align:right;}.interval-range{white-space:normal;overflow-wrap:anywhere;}
  .interval-gap{display:none;}.phone-gap{display:inline;color:var(--muted);font-size:9px;font-weight:400;}

 }
</style>
