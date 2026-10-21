<script lang="ts">
  import type {Snippet} from 'svelte';
  import Sheet from './Sheet.svelte';
  import Icon from './Icon.svelte';
  let {label,title=label,children,variant=''}:{label:string;title?:string;children:Snippet<[()=>void]>;variant?:string}=$props();
  let open=$state(false);
</script>
<details class={`action-menu ${variant}`} bind:open>
  <summary aria-label={label} aria-haspopup="dialog"><Icon name="more"/></summary>
  <Sheet bind:open {title}><div class="action-menu-content">{@render children(()=>open=false)}</div></Sheet>
</details>
<style>
  details{margin:0;flex:0 0 44px;}
  summary{display:grid;place-items:center;list-style:none;margin:0;width:44px;height:44px;cursor:pointer;border-radius:8px;color:var(--muted);}
  summary::-webkit-details-marker{display:none;}
  summary:hover{background:#ffffff08;color:var(--text);}
  .action-menu-content{display:grid;gap:12px;overflow-wrap:anywhere;}
</style>
