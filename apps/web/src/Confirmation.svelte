<script lang="ts">
 import {confirmation,answerConfirmation} from './confirmation.svelte';
 let dialog:HTMLDialogElement;
 $effect(()=>{if(confirmation.request)dialog?.showModal();else dialog?.close();});
</script>
<dialog bind:this={dialog} aria-labelledby="confirmation-title" aria-describedby="confirmation-message" oncancel={e=>{e.preventDefault();answerConfirmation(false);}}>
 {#if confirmation.request}
 <h2 id="confirmation-title">{confirmation.request.title}</h2>
 <p id="confirmation-message">{confirmation.request.message}</p>
 <div class="actions"><button class="outline" onclick={()=>answerConfirmation(false)}>Отмена</button><button class="danger" onclick={()=>answerConfirmation(true)}>{confirmation.request.confirmLabel}</button></div>
 {/if}
</dialog>
<style>
 dialog{box-sizing:border-box;width:min(420px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;background:var(--panel,#11141b);color:var(--text,#e8e9ef);border:1px solid var(--border);border-radius:12px;padding:22px;}dialog::backdrop{background:#0009;}h2{font-size:19px;margin:0 0 12px;}p{color:var(--muted);font-size:14px;line-height:1.5;overflow-wrap:anywhere;margin:0 0 20px;}.actions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;}.danger{background:#a53040;color:white;border:1px solid #c74657;}
</style>
