<script lang="ts">
 import Icon from './Icon.svelte';
 import type {PlatformLink} from './api';
 let {link,name,iconOnly=false}:{link:PlatformLink|undefined;name:string;iconOnly?:boolean}=$props();
</script>
{#if link}<a class="platform-profile-link" class:icon-only={iconOnly} class:twitch={link.source==='twitch'} class:youtube={link.source==='youtube'} href={link.url} target="_blank" rel="noopener noreferrer" aria-label={`Открыть ${name} на ${link.source==='twitch'?'Twitch':'YouTube'} (новая вкладка)`}>{#if !iconOnly}{link.source==='twitch'?'Twitch':'YouTube'} {/if}<Icon name="external" size={iconOnly?16:12}/></a>{/if}
<style>
 .platform-profile-link{display:inline-flex;align-items:center;gap:5px;min-height:32px;padding:3px 8px;border:1px solid var(--border);border-radius:6px;font-size:11px;line-height:1.3;text-decoration:none;white-space:nowrap;flex-shrink:0}.platform-profile-link:hover{border-color:currentColor}.twitch{color:var(--twitch,#a970ff)}.youtube{color:var(--youtube,#ff5959)}
.icon-only{min-height:28px;min-width:28px;padding:6px;border:0;border-radius:4px;justify-content:center}.icon-only:hover{background:var(--surface)}
</style>
