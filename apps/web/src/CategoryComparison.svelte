<script lang="ts">
 type Category={id:string;name:string;sessions:number;minutes:number;meanOnline:number|null;viewerCoverageRatio:number|null;viewerPartialMinutes:number;observedPerKnownMinute:number|null;coverageRatio:number|null;messagesPerHour:number};
 let {metric=$bindable<'meanOnline'|'observedPerKnownMinute'|'messagesPerHour'>('meanOnline'),categories,from,to,timezone}:{metric?:'meanOnline'|'observedPerKnownMinute'|'messagesPerHour';categories:Category[];from:number;to:number;timezone:string}=$props();
 const rows=$derived(categories.filter(c=>c.id&&c.name!=='Категория неизвестна').sort((a,b)=>(b[metric]??-1)-(a[metric]??-1)||a.name.localeCompare(b.name,'ru')));
 const max=$derived(Math.max(1,...rows.map(c=>c[metric]??0)));
 const number=(n:number)=>n.toLocaleString('ru-RU',{maximumFractionDigits:1});
 const date=(at:number)=>new Date(at).toLocaleDateString('ru-RU',{timeZone:timezone,day:'2-digit',month:'2-digit',year:'numeric'});
 const coverage=(c:Category)=>metric==='meanOnline'?c.viewerCoverageRatio:metric==='observedPerKnownMinute'?c.coverageRatio:null;
</script>
<section class="panel chart-panel category-comparison">
 <header><h2>Категории</h2><span class="muted">{from===0?'Всё время':date(from)} — {date(to)}</span></header>
 <div class="category-controls"><label>Метрика<select aria-label="Метрика категорий" bind:value={metric}><option value="meanOnline">Средний онлайн</option><option value="observedPerKnownMinute">В среднем в чате</option><option value="messagesPerHour">Сообщений/ч</option></select></label></div>
 <div class="category-rows">{#each rows as c}<article class="category-row"><div class="category-title"><h3>{c.name}</h3><strong>{c[metric]===null?'—':number(c[metric]??0)}</strong></div><div class="category-bar"><span style:width={`${(c[metric]??0)/max*100}%`}></span></div><p>{c.sessions} эфиров · {number(c.minutes/60)} ч{#if coverage(c)!==null&&coverage(c)!==undefined&&coverage(c)!<0.999} · данные за {Math.round(coverage(c)!*100)}% времени{/if}{#if metric==='meanOnline'&&c.viewerPartialMinutes>0} · неполные данные площадок{/if}</p></article>{:else}<p class="muted">Нет эфиров с известной категорией.</p>{/each}</div>
</section>
<style>
 header{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap}header span{font-size:11px}.category-controls{padding:0 16px 12px}.category-controls label{font-size:11px;color:var(--muted);display:flex;gap:8px;align-items:center}.category-controls select{width:auto;max-width:100%;min-width:0}.category-rows{padding:0 16px}.category-row{padding:14px 0;border-top:1px solid var(--border)}.category-title{display:flex;justify-content:space-between;align-items:baseline;gap:16px}.category-title h3{font-size:14px;font-weight:600;margin:0;overflow-wrap:anywhere}.category-title strong{font-size:18px;font-variant-numeric:tabular-nums}.category-bar{height:4px;background:var(--border);border-radius:4px;margin:10px 0}.category-bar span{display:block;height:100%;background:var(--accent);border-radius:inherit}.category-row p{font-size:11px;color:var(--muted);margin:0;line-height:1.5}
</style>
