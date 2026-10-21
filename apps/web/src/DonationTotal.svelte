<script lang="ts">
 import {onMount} from 'svelte';
 import {api,money} from './api';
 import Icon from './Icon.svelte';
 let {open}:{open:()=>void}=$props();
 let totals=$state<Record<string,string>|null>(null),failed=$state(false);
 onMount(()=>{const controller=new AbortController();let pending=false;
  const refresh=async()=>{if(pending)return;pending=true;try{const result=await api('overview',undefined,controller.signal);if(!controller.signal.aborted){totals=result.totals;failed=false;}}catch{if(!controller.signal.aborted)failed=true;}finally{pending=false;}};
  void refresh();window.addEventListener('sp:data-refresh',refresh);return()=>{controller.abort();window.removeEventListener('sp:data-refresh',refresh);};
 });
</script>
<button class="donation-total" onclick={open}><span>Донаты за всё время</span><strong>{#if totals}{Object.entries(totals).map(([c,a])=>money(a,c)).join(' · ')||'—'}{:else}{failed?'Недоступно':'…'}{/if}</strong><Icon name="arrow" size={18}/></button>
