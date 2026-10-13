<script lang="ts">
 import type {Period} from './period';
 let {value,label='Период',days=[7,30],custom=false,onchange}:{value:Period;label?:string;days?:readonly number[];custom?:boolean;onchange:(value:Period)=>void}=$props();
</script>
<label class="period-select">{label}<select aria-label={label} {value} onchange={e=>onchange(e.currentTarget.value==='all'?'all':e.currentTarget.value==='custom'?'custom':Number(e.currentTarget.value))}>{#each days as n}<option value={n}>Последние {n} {n===1?'сутки':'дней'}</option>{/each}<option value="all">Вся история</option>{#if custom}<option value="custom">Свои даты</option>{/if}</select></label>
<style>label{display:grid;gap:6px;font-size:12px;min-width:160px;max-width:100%}select{width:100%;min-width:0}</style>
