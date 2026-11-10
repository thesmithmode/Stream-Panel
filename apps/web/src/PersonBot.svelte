<script lang="ts">
 import {untrack,tick} from 'svelte';
 import {api} from './api';
 import type {ClassificationState as State} from './classification';
 let {personId,revision,onChange,state:providedState,compact=false,personName=''}:{personId:string;revision:number;onChange:()=>Promise<void>;state?:State|null;compact?:boolean;personName?:string}=$props();
 type Kind='bot'|'unknown'|'human';
 const choices:Kind[]=['bot','unknown','human'];
 const labels={bot:'Бот',unknown:'Неизвестно',human:'Человек'};
 let root:HTMLDivElement|undefined,loadedId='';
 let metadata=$state<State|null>(null),busy=$state(false),error=$state(''),pendingKind=$state<Kind|null>(null);
 const locked=$derived(metadata?.automaticHuman===true);
 const lockReason='Статус «Человек» закреплён связанными аккаунтами или донатами. Изменение недоступно.';
 const selected=$derived<Kind>(pendingKind??(metadata?.automaticHuman||metadata?.manualHuman?'human':metadata?.manualBot||metadata?.knownBot?'bot':'unknown'));
 $effect(()=>{
  if(providedState!==undefined){metadata=providedState;loadedId=providedState?personId:'';return;}
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
<div class="classification-control" class:locked class:compact title={locked?lockReason:undefined} bind:this={root}>
 <div class="classification" class:bot={selected==='bot'} class:human={selected==='human'} class:loading={!metadata} role="radiogroup" tabindex="-1" aria-label={compact?`Тип участника · ${personName}`:'Тип участника'} aria-busy={busy} title={locked?lockReason:labels[selected]} onkeydown={keyboard}>
  <span class="thumb" style:transform={`translateX(${choices.indexOf(selected)*(compact?17:21)}px)`}>{#if locked}<svg class="classification-lock" role="img" aria-label={lockReason} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>{/if}</span>
  {#each choices as kind}<button type="button" role="radio" data-kind={kind} aria-label={labels[kind]} aria-checked={selected===kind} tabindex={selected===kind?0:-1} disabled={disabled(kind)} onclick={()=>void select(kind)}><span class="stop"></span></button>{/each}
 </div>
 {#if error}<p class="classification-error" role="alert">{error}</p>{/if}
</div>
<style>
 .classification-control{position:relative;display:inline-flex;align-items:center;width:71px;flex:0 0 71px;}
 .compact{width:59px;flex-basis:59px;}
 .compact .classification{width:59px;height:24px;}
 .compact .classification button{flex-basis:17px;width:17px;height:16px;}
 .compact .thumb{width:15px;height:16px;}
 .compact .classification-error{left:0;right:auto;}
 .classification{position:relative;display:flex;width:71px;height:28px;padding:3px;border:1px solid var(--border);border-radius:16px;background:linear-gradient(90deg,#287eac 0%,var(--bg,#101217) 48%,var(--bg,#101217) 52%,#9b3d49 100%);color:#9298a5;isolation:isolate;}
 .classification.bot{color:#69bce9;border-color:rgba(105,188,233,.4);}
 .classification.human{color:#ed8990;border-color:rgba(237,137,144,.4);}
 .classification button{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;flex:0 0 21px;width:21px;height:20px;min-width:0;min-height:0;padding:0;border:0;border-radius:50%;background:transparent;color:inherit;box-shadow:none;cursor:pointer;}
 .classification button:disabled{cursor:default;opacity:1;}
 .classification button:focus-visible{outline:2px solid currentColor;outline-offset:3px;}
 .stop{width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.55;}
 .thumb{position:absolute;left:3px;top:3px;width:19px;height:20px;border-radius:50%;background:currentColor;opacity:.9;pointer-events:none;transition:transform .16s ease;}
 .loading{opacity:.4;}
 .locked{filter:grayscale(1);opacity:.48;}
 .locked .classification,.locked .classification button{cursor:not-allowed;}
 .classification-lock{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:var(--bg,#101217);}
 .classification-error{position:absolute;right:0;top:100%;width:240px;max-width:70vw;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg,#101217);z-index:5;}
 @media(prefers-reduced-motion:reduce){.thumb{transition:none;}}
</style>
