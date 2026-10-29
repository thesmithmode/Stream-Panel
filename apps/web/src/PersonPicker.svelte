<script lang="ts">
 import {onMount} from 'svelte';
 import {api,getProfile} from './api';
 let {value=$bindable(''),label,searchLabel='Поиск человека',includeBots=false,nullable=false,excludeId='',suggestedIds=[],disabled=false}:{value?:string;label:string;searchLabel?:string;includeBots?:boolean;nullable?:boolean;excludeId?:string;suggestedIds?:string[];disabled?:boolean}=$props();
 type Option={id:string;display_name:string};
 let revision=$state(0);onMount(()=>{const update=()=>revision++;window.addEventListener('sp:data-refresh',update);return()=>window.removeEventListener('sp:data-refresh',update);});
 let search=$state(''),offset=$state(0),items=$state<Option[]>([]),chosen=$state<Option|null>(null),total=$state(0),busy=$state(false),error=$state('');
 $effect(()=>{void search;offset=0;});
 $effect(()=>{
  const selected=value,term=search,page=offset,profile=getProfile();void revision;
  const controller=new AbortController();busy=true;error='';
  const timer=setTimeout(()=>{void api<{items:Option[];selectedItem:Option|null;total:number}>(`persons/options?${new URLSearchParams({search:term,offset:String(page),limit:'50',includeBots:includeBots?'1':'0',selected,exclude:excludeId})}`,undefined,controller.signal,profile).then(r=>{if(!controller.signal.aborted){items=r.items;chosen=r.selectedItem;total=r.total;}}).catch(e=>{if(!controller.signal.aborted)error=e.message;}).finally(()=>{if(!controller.signal.aborted)busy=false;});},term?200:0);
  return()=>{clearTimeout(timer);controller.abort();};
 });
 const options=$derived([...new Map([...(chosen?[chosen]:[]),...items].filter(p=>p.id!==excludeId).map(p=>[p.id,p])).values()]);
</script>
<div class="person-picker">
 <label>{searchLabel}<input {disabled} bind:value={search} placeholder="Имя или ник" /></label>
 <label>{label}<select aria-label={label} {disabled} bind:value><option value="">{nullable?'Без привязки':'Выберите человека'}</option>{#each options as p (p.id)}<option value={p.id}>{p.display_name}{suggestedIds.includes(p.id)?" · совпадает имя":""}</option>{/each}</select></label>
 {#if error}<p role="alert">{error}</p>{/if}
 {#if total>50}<div class="actions"><button type="button" disabled={busy||offset===0} onclick={()=>offset=Math.max(0,offset-50)}>Предыдущие варианты</button><span>{offset+1}–{Math.min(offset+50,total)} из {total}</span><button type="button" disabled={busy||offset+50>=total} onclick={()=>offset+=50}>Следующие варианты</button></div>{/if}
</div>
<style>.person-picker,label{display:grid;gap:6px;min-width:0;}input,select{width:100%;min-width:0;}</style>
