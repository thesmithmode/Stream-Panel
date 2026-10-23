<script lang="ts">
  import type {Snippet} from 'svelte';
  import Sheet from './Sheet.svelte';
  import Icon from './Icon.svelte';
  let {label,title=label,children,variant=''}:{label:string;title?:string;children:Snippet<[()=>void]>;variant?:string}=$props();
  let open=$state(false);
  let trigger=$state<HTMLElement>();
  let wasOpen=false;
  $effect(()=>{if(open)wasOpen=true;else if(wasOpen){wasOpen=false;trigger?.focus();}});
</script>
<details class={`action-menu ${variant}`} {open}>
  <summary bind:this={trigger} aria-label={label} aria-haspopup="dialog" aria-expanded={open} onclick={event=>{event.preventDefault();open=!open;}}><Icon name="more"/></summary>
  {#if open}<Sheet bind:open {title} {trigger} compact><div class="action-menu-content">{@render children(()=>open=false)}</div></Sheet>{/if}
</details>
<style>
  details{margin:0;flex:0 0 44px;}
  summary{display:grid;place-items:center;list-style:none;margin:0;width:44px;height:44px;cursor:pointer;border-radius:8px;color:var(--muted);}
  summary::-webkit-details-marker{display:none;}
  summary:hover{background:#ffffff08;color:var(--text);}
  .action-menu-content{display:grid;gap:12px;overflow-wrap:anywhere;}
</style>
