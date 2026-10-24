<script lang="ts">
 type Category={id:string;name:string;sessions:number;minutes:number;audience:number;core:number;messagesPerHour:number};
 let {categories,from,to,timezone}:{categories:Category[];from:number;to:number;timezone:string}=$props();
 let metric=$state<'messagesPerHour'|'audience'>('messagesPerHour');
 const rows=$derived(categories.filter(c=>c.id&&c.name!=='Категория неизвестна').sort((a,b)=>b[metric]-a[metric]||a.name.localeCompare(b.name,'ru')));
 const max=$derived(Math.max(1,...rows.map(c=>c[metric])));
 const number=(n:number)=>n.toLocaleString('ru-RU',{maximumFractionDigits:1});
 const date=(at:number)=>new Date(at).toLocaleDateString('ru-RU',{timeZone:timezone,day:'2-digit',month:'2-digit',year:'numeric'});
</script>
<section class="panel chart-panel category-comparison">
 <header><h2>Категории</h2><span class="muted">{from===0?'Всё время':date(from)} — {date(to)}</span></header>
 <div class="period-chips" role="group" aria-label="Метрика категорий"><button class:active={metric==='messagesPerHour'} aria-pressed={metric==='messagesPerHour'} onclick={()=>metric='messagesPerHour'}>Сообщений/ч</button><button class:active={metric==='audience'} aria-pressed={metric==='audience'} onclick={()=>metric='audience'}>Участники</button></div>
 <div class="category-rows">{#each rows as c}<article class="category-row"><div class="category-title"><h3>{c.name}</h3><strong>{number(c[metric])}</strong></div><div class="category-bar"><span style:width={`${c[metric]/max*100}%`}></span></div><p>{c.sessions} эфиров · {number(c.minutes/60)} ч · {c.audience} участников · {c.core} в ядре</p></article>{:else}<p class="muted">Нет эфиров с известной категорией.</p>{/each}</div>
 <p class="category-note muted">Участники — за выбранный период. Активность — на час эфира.</p>
</section>
<style>
 header{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap}header span{font-size:11px}.period-chips{padding:0 16px 12px}.category-rows{padding:0 16px}.category-row{padding:14px 0;border-top:1px solid var(--border)}.category-title{display:flex;justify-content:space-between;align-items:baseline;gap:16px}.category-title h3{font-size:14px;font-weight:600;margin:0;overflow-wrap:anywhere}.category-title strong{font-size:18px;font-variant-numeric:tabular-nums}.category-bar{height:4px;background:var(--border);border-radius:4px;margin:10px 0}.category-bar span{display:block;height:100%;background:var(--accent);border-radius:inherit}.category-row p,.category-note{font-size:11px;color:var(--muted);margin:0;line-height:1.5}.category-note{padding:0 16px 14px}
</style>
