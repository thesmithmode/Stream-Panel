<script lang="ts">
  import type {Snippet} from 'svelte';
  let {open=$bindable(false),title,children,compact=false,trigger}:{open?:boolean;title:string;children:Snippet;compact?:boolean;trigger?:HTMLElement}=$props();
  let dialog=$state<HTMLDialogElement>();
  $effect(()=>{
    if(!dialog)return;
    const element=dialog,origin=trigger;
    const position=()=>{
      if(!compact||innerWidth<=720){element.style.removeProperty('top');element.style.removeProperty('left');return;}
      const box=origin?.getBoundingClientRect();
      element.style.left=`${Math.max(8,Math.min((box?.right??innerWidth-24)-element.offsetWidth,innerWidth-element.offsetWidth-8))}px`;
      element.style.top=`${Math.max(8,Math.min((box?.bottom??64)+8,innerHeight-element.offsetHeight-8))}px`;
    };
    if(open&&!element.open){element.showModal();position();}
    else if(!open&&element.open){element.close();origin?.focus();}
    if(open)window.addEventListener('resize',position);
    return()=>window.removeEventListener('resize',position);
  });
</script>
<dialog class="sheet" class:compact aria-label={title} bind:this={dialog} onclose={()=>{if(!dialog?.open){open=false;trigger?.focus();}}} oncancel={event=>{event.preventDefault();open=false;}} onclick={event=>{if(event.target===dialog)open=false;}} onkeydown={event=>{if(event.key==='Escape'){event.preventDefault();open=false;}}}>
  <div class="sheet-body">
    <header><h2>{title}</h2><button class="icon-button" aria-label="Закрыть" onclick={()=>open=false}>×</button></header>
    {@render children()}
  </div>
</dialog>
<style>
  .sheet{position:fixed;inset:0 0 0 auto;margin:0;width:min(440px,100%);height:100dvh;max-height:100dvh;max-width:100%;padding:0;border:0;border-left:1px solid var(--border);background:var(--surface);color:var(--text);overflow:auto;overscroll-behavior:contain;}
  .sheet::backdrop{background:#0009;}
  @media(min-width:721px){.sheet.compact{inset:72px 24px auto auto;width:320px;height:auto;max-height:calc(100dvh - 16px);border:1px solid var(--border);border-radius:12px;box-shadow:0 12px 32px #0009}.sheet.compact::backdrop{background:transparent}.compact .sheet-body{padding:16px}}
  .sheet-body{padding:20px 20px calc(24px + env(safe-area-inset-bottom));}
  header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px;}
  header button{font-size:26px;}
  @media(max-width:720px){.sheet{inset:auto 0 0;width:100%;height:auto;max-height:90dvh;border:1px solid var(--border);border-radius:18px 18px 0 0;}.sheet-body{padding:16px 16px calc(24px + env(safe-area-inset-bottom));}}
</style>
