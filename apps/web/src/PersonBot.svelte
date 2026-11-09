<script lang="ts">
 import {untrack,tick} from 'svelte';
 import {api} from './api';
 let {personId,revision,onChange}:{personId:string;revision:number;onChange:()=>Promise<void>}=$props();
 type State={revision:number;canMarkBot:boolean;manualBot:boolean;knownBot:boolean;automaticHuman:boolean;manualHuman:boolean};
 type Kind='bot'|'unknown'|'human';
 const choices:Kind[]=['bot','unknown','human'];
 const labels={bot:'Бот',unknown:'Неизвестно',human:'Человек'};
 let root:HTMLDivElement|undefined,loadedId='';
 let metadata=$state<State|null>(null),busy=$state(false),error=$state(''),pendingKind=$state<Kind|null>(null);
 const selected=$derived<Kind>(pendingKind??(metadata?.automaticHuman||metadata?.manualHuman?'human':metadata?.manualBot||metadata?.knownBot?'bot':'unknown'));
 $effect(()=>{
  const id=personId,currentRevision=revision,current=untrack(()=>({id:loadedId,revision:metadata?.revision}));
  if(id===current.id&&currentRevision===current.revision)return;
  if(id!==current.id)metadata=null;error='';const controller=new AbortController();
  void api<State>(`persons/${id}/bot`,undefined,controller.signal).then(value=>{if(!controller.signal.aborted){loadedId=id;metadata=value;}}).catch(e=>{if(!controller.signal.aborted)error=e.message;});
  return()=>controller.abort();
 });
 function disabled(kind:Kind){return busy||!metadata||metadata.automaticHuman||(kind==='bot'&&!metadata.canMarkBot);}
 async function select(kind:Kind){
  if(disabled(kind)||kind===selected)return;
  const id=personId,current=metadata!,restoreFocus=root?.contains(document.activeElement);busy=true;pendingKind=kind;error='';
  try{const result=await api<State>(`persons/${id}/classification`,{kind,revision:current.revision});if(personId===id){loadedId=id;metadata=result;pendingKind=null;busy=false;void onChange().catch(e=>{if(personId===id)error=(e as Error).message;});}}
  catch(e){if(personId===id)error=(e as Error).message==='REVISION_CONFLICT'?'Карточка изменилась. Откройте её заново и повторите отметку.':(e as Error).message;}
  finally{pendingKind=null;busy=false;await tick();if(personId===id&&restoreFocus)root?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();}
 }
 function keyboard(event:KeyboardEvent){
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();
  const available=choices.filter(kind=>!disabled(kind));if(!available.length)return;
  const step=event.key==='ArrowLeft'?-1:1,index=available.indexOf(selected);
  const kind=event.key==='Home'?available[0]!:event.key==='End'?available.at(-1)!:available[(index+step+available.length)%available.length]!;
  void select(kind);
  (event.currentTarget as HTMLElement).querySelector<HTMLButtonElement>(`[data-kind="${kind}"]`)?.focus();
 }
</script>
<div class="classification-control" bind:this={root}>
 <span class="classification-label bot-label" aria-hidden="true">Бот</span>
 <div class="classification" class:bot={selected==='bot'} class:human={selected==='human'} class:loading={!metadata} role="radiogroup" tabindex="-1" aria-label="Тип участника" aria-busy={busy} title={metadata?.automaticHuman?'Человек · YouTube или DonationAlerts':labels[selected]} onkeydown={keyboard}>
  <span class="thumb" style:transform={`translateX(${choices.indexOf(selected)*21}px)`}></span>
  {#each choices as kind}<button type="button" role="radio" data-kind={kind} aria-label={labels[kind]} aria-checked={selected===kind} tabindex={selected===kind?0:-1} disabled={disabled(kind)} onclick={()=>void select(kind)}><span class="stop"></span></button>{/each}
 </div>
 <span class="classification-label human-label" aria-hidden="true">Человек</span>
 {#if error}<p class="classification-error" role="alert">{error}</p>{/if}
</div>
<style>
 .classification-control{position:relative;display:inline-flex;align-items:center;gap:6px;flex-shrink:0;}
 .classification-label{font-size:10px;line-height:1;white-space:nowrap;}
 .bot-label{color:#69bce9;}
 .human-label{color:#ed8990;}
 .classification{position:relative;display:flex;width:71px;height:28px;padding:3px;border:1px solid var(--border);border-radius:16px;background:linear-gradient(90deg,rgba(65,177,236,.38),transparent 48%,transparent 52%,rgba(239,104,112,.34)),var(--bg,#101217);color:#9298a5;isolation:isolate;}
 .classification.bot{color:#69bce9;border-color:rgba(105,188,233,.4);}
 .classification.human{color:#ed8990;border-color:rgba(237,137,144,.4);}
 .classification button{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;flex:0 0 21px;width:21px;height:20px;min-width:0;min-height:0;padding:0;border:0;border-radius:50%;background:transparent;color:inherit;box-shadow:none;cursor:pointer;}
 .classification button:disabled{cursor:default;opacity:1;}
 .classification button:focus-visible{outline:2px solid currentColor;outline-offset:3px;}
 .stop{width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.55;}
 .thumb{position:absolute;left:3px;top:3px;width:19px;height:20px;border-radius:50%;background:currentColor;opacity:.9;pointer-events:none;transition:transform .16s ease;}
 .loading{opacity:.4;}
 .classification-error{position:absolute;right:0;top:100%;width:240px;max-width:70vw;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg,#101217);z-index:5;}
 @media(prefers-reduced-motion:reduce){.thumb{transition:none;}}
</style>
