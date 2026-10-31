<script lang="ts">
 import {onMount} from 'svelte';
 import {api,getProfile} from './api';
 import Help from './Help.svelte';
 import {durationLabel} from './audience-ranking';
 import {sortChat,messageAge,type CurrentChat,type ChatSort} from './current-chat';
 let {sessionId,onPerson}:{sessionId:string;onPerson:(id:string)=>void}=$props();
 let data=$state<CurrentChat|null>(null),error=$state(''),search=$state(''),includeExcluded=$state(false);
 let sort=$state<ChatSort>('minutes'),descending=$state(true),limit=$state(50),now=$state(Date.now());
 let generation=0,controller:AbortController|undefined,lastLoaded=0;
 const rows=$derived(sortChat(data?.people??[],search,sort,descending));
 const arrow=(key:ChatSort)=>sort===key?(descending?' ↓':' ↑'):' ↕';
 function order(key:ChatSort){if(sort===key)descending=!descending;else{sort=key;descending=key!=='name';}limit=50;}
 async function load(){
  controller?.abort();controller=new AbortController();const id=++generation;
  const path=`sessions/${encodeURIComponent(sessionId)}/current-chat?includeExcluded=${includeExcluded?'1':'0'}`;
  lastLoaded=Date.now();
  try{const next=await api<CurrentChat>(path,undefined,controller.signal,getProfile());if(id===generation){data=next;now=Date.now();error='';}}
  catch(e){if(id===generation&&!controller.signal.aborted)error='Не удалось обновить список. Показаны последние полученные данные.';}
 }
 $effect(()=>{void sessionId;void includeExcluded;data=null;error='';limit=50;void load();return()=>{generation++;controller?.abort();};});
 $effect(()=>{void search;limit=50;});
 onMount(()=>{
  const refresh=(event:Event)=>{if(document.hidden||!navigator.onLine)return;const force=(event as CustomEvent).detail?.force;if(force||Math.floor(Date.now()/60000)!==Math.floor(lastLoaded/60000))void load();};
  window.addEventListener('sp:data-refresh',refresh);
  return()=>{generation++;controller?.abort();window.removeEventListener('sp:data-refresh',refresh);};
 });
</script>
<section class="panel current-chat" aria-label="Текущие зрители">
 <header><div><h2>Сейчас в чате{#if data} · {data.people.length}{/if}</h2>
 <p class="small muted" role="status">{#if data?.observedAt}Twitch · замер {messageAge(data.observedAt,now).replace('Только что','только что')}{:else if data?.twitchState==='waiting'}Twitch · ожидаем первый замер{:else if data?.twitchState==='inactive'}Twitch-эфир не идёт{:else if !data}Загружаем список…{/if}</p></div>
 <Help id="current-chat-help" label="О текущих зрителях" text="Twitch показывает подключённых к чату, включая молчащих, с задержкой. Время в чате и сообщения считаются за текущий стрим; это не подтверждённое время просмотра видео. YouTube отмечен красным и @: здесь только писавшие за последние 10 минут, присутствие и время просмотра неизвестны. Список обновляется вместе со страницей раз в минуту."/>
 </header>
 <div class="chat-controls"><input aria-label="Поиск по нику" type="search" placeholder="Поиск по нику" bind:value={search}/></div>
 {#if error}<p class="notice error" role="alert">{error} <button class="text-button" onclick={()=>load()}>Повторить</button></p>{/if}
 {#if data?.twitchState==='stale'}<p class="notice" role="status">Список Twitch не обновлён. Последний успешный замер не подтверждает присутствие прямо сейчас.</p>{/if}
 {#if data&&!data.live}<p class="empty-small">Эфир завершён. История доступна во вкладке «Участники».</p>{:else if data}
 {#if search}<p class="small muted search-count">Найдено: {rows.length} из {data.people.length}</p>{/if}
 <div class="table-scroll"><table><thead><tr>
 {#each [['name','Участник','Ник'],['minutes','В чате','В чате'],['messages','Сообщения','Сообщ.'],['lastMessageAt','Последнее сообщение','Последнее сообщ.']] as [key,desktop,phone]}
 <th scope="col" aria-sort={sort===key?(descending?'descending':'ascending'):'none'}><button onclick={()=>order(key as ChatSort)} aria-label={`${desktop}${arrow(key as ChatSort)}`}><span class="desktop-label">{desktop}</span><span class="phone-label">{phone}</span>{arrow(key as ChatSort)}</button></th>
 {/each}
 </tr></thead><tbody>
 {#each rows.slice(0,limit) as person (person.key)}<tr data-chatter-key={person.key}>
 <td><button class="text-button person-name" class:twitch={person.source==='twitch'} class:youtube={person.source==='youtube'} title={`${person.source==='twitch'?'Twitch':'YouTube · писал за последние 10 минут'} · ${person.name}`} onclick={()=>onPerson(person.personId)}>{person.source==='youtube'&&!person.name.startsWith('@')?'@':''}{person.name}</button></td>
 <td>{person.minutes===null?'—':durationLabel(person.minutes)}</td><td>{person.messages.toLocaleString('ru-RU')}</td><td><time title={person.lastMessageAt===null?'Не писал в текущем стриме':new Date(person.lastMessageAt).toLocaleString('ru-RU')}>{messageAge(person.lastMessageAt,now)}</time></td>
 </tr>{:else}<tr><td colspan="4" class="empty-small">{search?'Никто не найден':data.observedAt===null&&data.twitchState!=='inactive'?'Данные списка Twitch пока недоступны.':'Нет участников в последнем списке Twitch и недавних сообщений YouTube.'}</td></tr>{/each}
 </tbody></table></div>
 {#if rows.length>limit}<button class="outline small more" onclick={()=>limit+=50}>Показать ещё ({rows.length-limit})</button>{/if}
 {/if}
 <label class="small chat-filter"><input type="checkbox" bind:checked={includeExcluded}/> Показать владельца и ботов</label>
 <p class="small muted chat-note">Время и сообщения — за текущий стрим. <span class="youtube">@YouTube</span> — писали за последние 10 минут; время присутствия неизвестно.</p>
</section>
<style>
 header{display:flex;align-items:start;gap:12px}header>div{flex:1}h2{margin:0}header p{margin:6px 0 0}
 .chat-controls{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:12px}.chat-controls>input{max-width:320px;flex:1;min-width:160px}.chat-filter{display:flex;align-items:center;gap:8px;color:var(--muted);padding:12px 12px 0}.chat-filter input[type=checkbox]{width:16px;min-height:16px}
 .table-scroll{overflow-x:auto;max-width:100%}table{width:100%;border-collapse:collapse}th,td{text-align:right;padding:6px 12px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums}th:first-child,td:first-child{text-align:left}th:first-child{width:40%}th{color:var(--muted);font-size:12px;font-weight:400}th button{border:0;background:none;color:inherit;font:inherit;min-height:44px;padding:0;cursor:pointer}th[aria-sort=ascending],th[aria-sort=descending]{color:var(--accent)}td{font-size:13px}.person-name{min-height:44px;display:block;text-align:left;overflow-wrap:anywhere}.twitch{color:var(--twitch,#a970ff)!important}.youtube{color:var(--youtube,#ff5959)!important}.phone-label{display:none}.chat-note{padding:12px;margin:0;line-height:1.6}.more{margin:12px}.search-count{padding:0 12px}.notice{margin:0 12px 12px}
 @media(max-width:720px){table{table-layout:fixed}th,td{padding:6px;font-size:12px;overflow-wrap:anywhere}th:first-child{width:34%}th:nth-child(2){width:22%}th:nth-child(3){width:16%}th:nth-child(4){width:28%}.desktop-label{display:none}.phone-label{display:inline}.person-name{font-size:12px;max-width:100%;padding-inline:0}.chat-controls{gap:10px}.chat-controls>input{max-width:none;flex-basis:100%}th button{white-space:normal;line-height:1.35}td:last-child{color:var(--muted)}.chat-note{font-size:11px}}
</style>
