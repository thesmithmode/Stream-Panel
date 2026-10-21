<script lang="ts">
 import Help from './Help.svelte';
 import {type RankPerson,presenceMinutes,rankTable,intervalRows,durationLabel} from './audience-ranking';
 import {intervalRange} from './stream-time';
 import {money} from './api';
 let {people,onPerson,showIntervals=false,streamStart=0,streamEnd=0}:{people:RankPerson[];onPerson:(id:string)=>void;showIntervals?:boolean;streamStart?:number;streamEnd?:number}=$props();
 const id=$props.id();
 let metric=$state('presence'),descending=$state(true),limit=$state(50);
 const currencies=$derived([...new Set(people.flatMap(p=>Object.keys(p.donations??{})))].sort());
 const ranked=$derived(rankTable(people,metric,descending));
 $effect(()=>{void people;void metric;limit=50;});
 function sort(key:string){if(metric===key)descending=!descending;else{metric=key;descending=true;}}
 const arrow=(key:string)=>metric===key?(descending?' ↓':' ↑'):'';
</script>
<section class="panel audience-ranking" aria-label="Рейтинг участников">
 <header><h2>Участники чата</h2><Help id={`${id}-help`} label="О времени участников" text="Время в эфире объединяет интервалы Twitch и YouTube без двойного подсчёта пересечений. Twitch — наблюдаемое присутствие в чате, YouTube — оценка по сообщениям. Площадки не раскрывают персональное время просмотра видео. Пауза означает отсутствие сохранённых сигналов, а не подтверждённый уход зрителя. Среднее число участников считается по всей длительности эфира; пропуски наблюдений могут его занижать."/></header>
 <div class="ranking-sort"><label>Сортировать<select aria-label="Сортировка участников" value={metric} onchange={e=>{metric=e.currentTarget.value;descending=true;}}><option value="presence">Время в чате</option><option value="messages">Сообщения</option><option value="name">Имя</option>{#each currencies as c}<option value={`donation:${c}`}>Донаты · {c}</option>{/each}</select></label><button class="outline" aria-label="Изменить порядок" onclick={()=>descending=!descending}>{descending?'По убыванию':'По возрастанию'}</button></div>
 <div class="table-scroll"><table>
  <thead><tr><th aria-sort={metric==='name'?(descending?'descending':'ascending'):'none'}><button onclick={()=>sort('name')}>Участник{arrow('name')}</button></th>
  <th aria-sort={metric==='presence'?(descending?'descending':'ascending'):'none'}><button onclick={()=>sort('presence')}>Время в чате{arrow('presence')}</button></th>
  <th aria-sort={metric==='messages'?(descending?'descending':'ascending'):'none'}><button onclick={()=>sort('messages')}>Сообщения{arrow('messages')}</button></th>
  {#each currencies as currency}<th aria-sort={metric===`donation:${currency}`?(descending?'descending':'ascending'):'none'}><button onclick={()=>sort(`donation:${currency}`)}>Донаты, {currency}{arrow(`donation:${currency}`)}</button></th>{/each}</tr></thead>
  <tbody>{#each ranked.slice(0,limit) as person (person.id)}<tr><td>
   {#if person.accounts?.length===1&&person.accounts[0]?.name===person.name}<button class="text-button person-name" class:twitch={person.accounts[0].source==='twitch'} class:youtube={person.accounts[0].source==='youtube'} onclick={()=>onPerson(person.id)}>{person.name}</button>{:else}<button class="text-button person-name" onclick={()=>onPerson(person.id)}>{person.name}</button>{/if}
   {#if (person.accounts?.length??0)>1||(person.accounts?.length===1&&person.accounts[0]?.name!==person.name)}<details class="account-details"><summary>Аккаунты</summary><div class="accounts">{#each (person.accounts?.length===1&&person.accounts[0]?.name===person.name?[]:person.accounts??[]) as account}<button class="text-button" class:twitch={account.source==='twitch'} class:youtube={account.source==='youtube'} onclick={()=>onPerson(person.id)}>{account.name}</button>{/each}</div></details>{/if}
   {#if showIntervals&&person.intervals?.length}<details class="compact-details"><summary aria-label={`Интервалы ${person.name}`}>Интервалы</summary>
    <div class="interval-list">{#each intervalRows(person.intervals) as span}
     {#if span.gap>0}<div class="interval-gap">Пауза · {durationLabel(span.gap/60000)}</div>{/if}
     <div class="interval-row"><span class:twitch={span.kind==='observed'} class:youtube={span.kind!=='observed'}>{span.kind==='observed'?'Twitch':'YouTube · оценка'}</span><time>{intervalRange(span.from,span.to,streamStart,streamEnd)}</time><strong>{durationLabel((span.to-span.from)/60000)}</strong></div>
    {/each}</div>
   </details>{/if}
  </td><td data-label="Время в чате"><strong>{durationLabel(presenceMinutes(person))}</strong></td><td data-label="Сообщения">{person.messages??0}</td>{#each currencies as currency}<td data-label={`Донаты · ${currency}`}>{BigInt(person.donations?.[currency]??'0')===0n?'—':money(person.donations![currency]!,currency)}</td>{/each}</tr>
  {:else}<tr><td colspan={3+currencies.length} class="muted">Нет сохранённых данных об участниках</td></tr>{/each}</tbody>
 </table></div>
 {#if ranked.length>limit}<button class="outline small more" onclick={()=>limit+=50}>Показать ещё ({ranked.length-limit})</button>{/if}
</section>
<style>
 header{gap:12px;}h2{margin-right:auto}.table-scroll{overflow-x:auto;max-width:100%}table{width:100%;border-collapse:collapse}th,td{padding:14px 18px;border-bottom:1px solid var(--border);text-align:right;vertical-align:top}th:first-child,td:first-child{text-align:left;width:100%}th{font-size:12px;color:var(--muted);white-space:nowrap}th button{background:none;border:0;color:inherit;font:inherit;cursor:pointer;padding:0}td{font-size:13px;white-space:nowrap}tbody tr:last-child td{border-bottom:0}.person-name{font-size:14px;text-align:left;white-space:normal;overflow-wrap:anywhere}.accounts{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:4px}.accounts button{font-size:12px;text-align:left;white-space:normal;overflow-wrap:anywhere}.twitch{color:var(--twitch,#a970ff)!important}.youtube{color:var(--youtube,#ff5959)!important}.compact-details{font-size:12px;margin-top:8px}.interval-list{display:grid;gap:8px;padding:10px 0}.interval-row{display:grid;gap:3px;white-space:normal}.interval-row time{color:var(--muted)}.interval-gap{color:var(--muted);padding:6px 0;border-top:1px dashed var(--border);white-space:normal}.more{margin:12px 18px}@media(max-width:600px){th,td{padding:12px 8px}th{white-space:normal;max-width:90px}td:first-child{min-width:125px}.person-name{font-size:13px}}

 .ranking-sort{display:none}.account-details{font-size:12px;margin-top:8px}
 @media(max-width:720px){.ranking-sort{display:flex;gap:12px;padding:0 14px 14px;align-items:end;flex-wrap:wrap}.ranking-sort label{display:grid;gap:6px;min-width:0;flex:1;font-size:13px}.ranking-sort select{width:100%;min-width:0;font-size:14px}.ranking-sort button{font-size:13px;padding:8px}.table-scroll{overflow:visible}table,tbody{display:block}thead{display:none}tbody tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:16px;border-top:1px solid var(--border)}th,td{display:block;width:auto!important;min-width:0!important;padding:0;border:0;white-space:normal;text-align:left;font-size:15px}td:first-child{grid-column:1/-1}.person-name{font-size:16px}td[data-label]::before{content:attr(data-label);display:block;color:var(--muted);font-size:12px;margin-bottom:4px}.compact-details{margin-top:8px}.account-details>summary,.compact-details>summary{min-height:32px;align-content:center}}
</style>
