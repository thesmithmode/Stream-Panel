<script lang="ts">
 import type {Session} from './api';
 import {money} from './api';
 import {formatDuration} from './duration';
 import {sessionGroup} from './session-group';
 import {compactStreamRange as streamRange} from './stream-time';
 import Help from './Help.svelte';
 import ActionMenu from './ActionMenu.svelte';
 import {routeUrl} from './route';
 import {getProfile} from './api';
 let {sessions,selected=$bindable([]),busy=false,page,onpage,onopen,onmerge,onunmerge,ondelete,validUrl}:{sessions:Session[];selected?:string[];busy?:boolean;page:number;onpage:(page:number)=>void;onopen:(id:string)=>void;onmerge:()=>Promise<void>;onunmerge:(id:string)=>void;ondelete:(id:string)=>void;validUrl:(entry:{platform:string;url:string})=>boolean}=$props();
 let selecting=$state(false);
 function toggle(id:string,checked:boolean){selected=checked?[...selected,id]:selected.filter(s=>s!==id);}
 function selection(){selecting=!selecting;if(!selecting)selected=[];}
</script>
<section class="stream-history" aria-label="История стримов">
 <div class="history-toolbar"><span>История эфиров</span><button class="text-button" aria-pressed={selecting} onclick={selection}>{selecting?'Отмена':'Выбрать'}</button></div>
 {#if selecting}<div class="selection-toolbar"><span>Выбрано: {selected.length}</span><button class="primary" disabled={busy||selected.length<2} onclick={async()=>{await onmerge();if(!selected.length)selecting=false;}}>Объединить выбранные</button><Help id="merge-help" label="Об объединении эфиров" text="Выберите до 100 частей в пределах 31 дня. Активным может быть только последний эфир. Объединение можно отменить; перерывы сохраняются."/></div>{/if}
 {#each sessions as session,index (session.id)}
  {#if index===0||sessionGroup(session.started_at_ms)!==sessionGroup(sessions[index-1]!.started_at_ms)}<h2 class="history-date">{sessionGroup(session.started_at_ms)}</h2>{/if}
  <article class="stream-card" data-session-id={session.id}>
   <a class="stream-open" aria-label={`Открыть ${session.primaryTitle||'стрим'}`} href={routeUrl({view:'stream',session:session.id,person:'',profile:getProfile()})} onclick={e=>{e.preventDefault();onopen(session.id);}}>
   <div class="stream-card-heading">
    <div><span class="stream-period">{streamRange(session.started_at_ms,session.ended_at_ms)}</span><h3>{session.primaryTitle||'Без названия'}</h3><span class="stream-platforms">{session.platforms?.map(p=>p==='twitch'?'Twitch':'YouTube').join(' · ')||'Источник неизвестен'}{#if session.ended_at_ms===null}<span class="live-label">В эфире</span>{/if}{#if (session.memberIds?.length??0)>1}<span> · {session.memberIds!.length} части</span>{/if}</span></div>
   </div>
   <dl class="stream-card-metrics">
    <div><dt>Длительность</dt><dd>{formatDuration((session.durationMs??((session.ended_at_ms??Date.now())-session.started_at_ms))/60000)}</dd></div>
    <div><dt>Средние зрители</dt><dd>{(session.viewerPartial?session.viewerKnownMean:session.viewerMean)?.toLocaleString('ru-RU',{maximumFractionDigits:1})??'—'}</dd></div>
    <div><dt>Донаты</dt><dd>{Object.entries(session.donationTotals??{}).map(([c,a])=>money(a,c)).join(' · ')||'—'}</dd></div>
    <div><dt>Сообщения</dt><dd>{session.messageCount??0}</dd></div>
   </dl></a>
   {#if selecting&&session.kind==='platform'}<label class="stream-selection"><input type="checkbox" aria-label="Выбрать стрим" checked={selected.includes(session.id)} disabled={busy} onchange={event=>toggle(session.id,event.currentTarget.checked)}/>Выбрать</label>{/if}
   <ActionMenu variant="stream-actions" label={`Действия: ${session.primaryTitle||'стрим'}`} title="Детали эфира">{#snippet children(close)}
    {#if session.viewerPartial}<span class="small muted">Неполные данные площадок: сумма известных зрителей.</span>{/if}<span class="small muted">Пик зрителей: {(session.viewerPartial?session.viewerKnownPeak:session.viewerPeak)??'—'}</span><span class="small muted">Донатов: {session.donationCount??0}</span>
    {#each (session.confirmedUrls??[]).filter(validUrl) as entry,index}<a href={entry.url} target="_blank" rel="noopener noreferrer">{entry.platform==='twitch'?'Twitch':'YouTube'}{(session.confirmedUrls??[]).filter(e=>e.platform===entry.platform).length>1?` · часть ${(session.confirmedUrls??[]).filter(validUrl).slice(0,index+1).filter(e=>e.platform===entry.platform).length}`:''}</a>{/each}
    {#each session.breaks??[] as pause}<span class="small">Перерыв: {streamRange(pause.from,pause.to)}</span>{/each}
    {#if (session.memberIds?.length??0)>1}<button disabled={busy} onclick={()=>{close();onunmerge(session.id);}}>Разъединить</button>{/if}
    {#if session.kind==='manual'}<button class="danger" disabled={busy} onclick={()=>{close();ondelete(session.id);}}>Удалить</button>{/if}
   {/snippet}</ActionMenu>
  </article>
 {:else}<div class="empty-small">Стримов пока нет</div>{/each}
 {#if page>0||sessions.length>=100}<div class="history-pages"><button class="outline" disabled={busy||page===0} onclick={()=>onpage(page-1)}>Назад</button><span>Страница {page+1}</span><button class="outline" disabled={busy||sessions.length<100} onclick={()=>onpage(page+1)}>Далее</button></div>{/if}
</section>
