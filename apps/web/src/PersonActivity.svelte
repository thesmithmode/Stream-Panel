<script lang="ts">
 import {api,date} from './api';
 import {formatDuration} from './duration';
 let {personId}:{personId:string}=$props();
 let data=$state<any>(null),error=$state('');
 $effect(()=>{const id=personId;let cancelled=false;data=null;error='';void api(`persons/${id}/activity`).then(result=>{if(!cancelled)data=result;}).catch(e=>{if(!cancelled)error=e.message;});return()=>{cancelled=true;};});
 const maximum=$derived(Math.max(1,...(data?.hours??[]).map((h:any)=>h.minutes)));
</script>
{#if error}<p role="alert">{error}</p>{:else if data}
 <h3>Обычно в чате · МСК</h3>{#if data.hasEstimatedActivity}<p class="small muted">Активность YouTube оценена по сообщениям.</p>{/if}
 <div class="hours" aria-label="Активность человека по часам">{#each data.hours as h}<div title={`${h.hour}:00 · ${formatDuration(h.minutes)}`}><i style:height={`${h.minutes/maximum*90}px`}></i><small>{h.hour}</small></div>{/each}</div>
 <h3>Посещения стримов</h3>
 {#if data.visits.length}<div class="visits">{#each data.visits.slice(-30).reverse() as visit}<div><span>{date(visit.at)}</span><strong>{formatDuration(visit.minutes)}</strong></div>{/each}</div>{:else}<p class="muted">Активность в стримах пока не зафиксирована.</p>{/if}
 <details><summary>Баллы канала и награды</summary><p class="small muted">Текущий баланс Twitch API не раскрывает.</p>{#each data.rewards as reward}<p>{date(reward.at)} · {reward.title} · {reward.cost??'—'} баллов · {reward.status}</p>{:else}<p class="muted">Использования наград пока не зафиксированы.</p>{/each}</details>
{:else}<p role="status">Загружаем активность…</p>{/if}
<style>.hours{display:flex;align-items:end;height:120px;gap:3px;}.hours>div{flex:1;min-width:0;text-align:center;display:flex;flex-direction:column;justify-content:end;height:110px;}.hours i{display:block;background:#5fc4aa;border-radius:3px 3px 0 0;min-height:1px;}.hours small{font-size:10px;margin-top:5px;}.visits{display:grid;gap:8px;max-height:180px;overflow:auto;}.visits>div{display:flex;justify-content:space-between;gap:12px;font-size:13px;}details{margin-top:16px;}summary{cursor:pointer;}</style>
