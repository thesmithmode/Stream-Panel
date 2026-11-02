<script lang="ts">
 import Icon from './Icon.svelte';
 import type {PlatformLink} from './api';
 let {link,name}:{link:PlatformLink|undefined;name:string}=$props();
</script>
{#if link}<a class="platform-profile-link" class:twitch={link.source==='twitch'} class:youtube={link.source==='youtube'} href={link.url} target="_blank" rel="noopener noreferrer" aria-label={`Открыть ${name} на ${link.source==='twitch'?'Twitch':'YouTube'} (новая вкладка)`}>{link.source==='twitch'?'Twitch':'YouTube'} <Icon name="external" size={12}/></a>{/if}
<style>
 .platform-profile-link{display:inline-flex;align-items:center;gap:5px;min-height:32px;padding:3px 8px;border:1px solid var(--border);border-radius:6px;font-size:11px;line-height:1.3;text-decoration:none;white-space:nowrap;flex-shrink:0}.platform-profile-link:hover{border-color:currentColor}.twitch{color:var(--twitch,#a970ff)}.youtube{color:var(--youtube,#ff5959)}
</style>
