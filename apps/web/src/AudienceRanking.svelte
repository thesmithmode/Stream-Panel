<script lang="ts">
 import Help from './Help.svelte';
 import {audienceRanking,type RankMetric,type RankPerson} from './audience-ranking';
 let {people,onPerson}:{people:RankPerson[];onPerson:(id:string)=>void}=$props();
 const id=$props.id();
 let metric=$state<RankMetric>('observedMinutes'),limit=$state(50);
 const ranked=$derived(audienceRanking(people,metric));
 $effect(()=>{void people;void metric;limit=50;});
</script>
<section class="panel audience-ranking" aria-label="Рейтинг участников">
 <header><h2>Участники чата</h2><Help id={`${id}-help`} label="О рейтинге участников" text="Минуты в чате — сохранённые наблюдения Twitch, включая молчавших участников. Пропуски опросов не добавляют минуты. YouTube показан отдельно как оценка по сообщениям. Это не подтверждённое время просмотра видео."/><label>Рейтинг по<select bind:value={metric}><option value="observedMinutes">Минутам в чате</option><option value="messages">Сообщениям</option><option value="estimatedChatMinutes">Оценке YouTube</option></select></label></header>
 <ol>{#each ranked.slice(0,limit) as person}<li><button class="text-button" onclick={()=>onPerson(person.id)}>{person.name}</button><strong>{Number.isInteger(person[metric])?person[metric]:person[metric]?.toFixed(1)} {metric==='messages'?'сообщ.':'мин'}</strong></li>{:else}<li class="muted">{metric==='messages'?'Сообщений пока нет':'Нет сохранённых данных о присутствии'}</li>{/each}</ol>
 {#if ranked.length>limit}<button class="outline small" onclick={()=>limit+=50}>Показать ещё ({ranked.length-limit})</button>{/if}
</section>
<style>
 header{flex-wrap:wrap;gap:12px;}h2{display:flex;align-items:center;gap:8px;}label{display:grid;gap:6px;font-size:12px;min-width:160px;}ol{margin:0;padding:12px 20px 12px 44px;}li{padding:8px 0;}li button{max-width:70%;overflow-wrap:anywhere;white-space:normal;text-align:left;}strong{float:right;font-size:13px;padding-left:8px;}@media(max-width:600px){label{width:100%;}}
</style>
