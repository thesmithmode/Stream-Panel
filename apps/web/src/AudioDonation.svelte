<script lang="ts">
 import {audioUrl} from './labels';
 let {text}:{text?:unknown}=$props();
 const url=$derived(audioUrl({text}));
</script>
<span>Голосовое сообщение{#if url} · <a href={url} target="_blank" rel="noopener noreferrer">Слушать</a>{/if}</span>
