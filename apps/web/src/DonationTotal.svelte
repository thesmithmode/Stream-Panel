<script lang="ts">
 import {onMount} from 'svelte';
 import {api,money} from './api';
 import Icon from './Icon.svelte';
 let {open}:{open:()=>void}=$props();
 let recent=$state<Record<string,string>|null>(null),totals=$state<Record<string,string>|null>(null),failed=$state(false);
 onMount(()=>{const controller=new AbortController();let pending=false;
  const refresh=async()=>{if(pending)return;pending=true;try{const result=await api('overview',undefined,controller.signal);if(!controller.signal.aborted){totals=result.totals;recent=result.totals30??null;failed=false;}}catch{if(!controller.signal.aborted)failed=true;}finally{pending=false;}};
  void refresh();window.addEventListener('sp:data-refresh',refresh);return()=>{controller.abort();window.removeEventListener('sp:data-refresh',refresh);};
 });
</script>
<button class="donation-total" aria-label="Донаты за 30 дней и всё время" onclick={open}>
 <span class="donation-period"><span>За 30 дней</span><strong>{#if recent}{Object.entries(Object.keys(recent).length?recent:Object.fromEntries(Object.keys(totals??{}).map(c=>[c,'0']))).map(([c,a])=>money(a,c)).join(' · ')||'—'}{:else}{failed?'Недоступно':'…'}{/if}</strong></span>
 <span class="donation-period"><span>За всё время</span><strong>{#if totals}{Object.entries(totals).map(([c,a])=>money(a,c)).join(' · ')||'—'}{:else}{failed?'Недоступно':'…'}{/if}</strong></span><Icon name="arrow" size={18}/>
</button>
