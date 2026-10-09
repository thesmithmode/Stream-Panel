<script lang="ts">
  import { api, date } from "./api";
  let { personId }: {personId:string} = $props();
  type Note = {id:string;body:string;created_at_ms:number;updated_at_ms:number;revision:number};
  let notes = $state<Note[]>([]), draft = $state(""), editing = $state<Note|null>(null), editBody = $state(""), busy = $state(false), error = $state("");
  $effect(() => {
    const id=personId;
    let cancelled=false;
    void api<Note[]>(`persons/${id}/notes`).then(rows=>{if(!cancelled)notes=rows;}).catch(e=>{if(!cancelled)error=e.message;});
    return ()=>{cancelled=true;};
  });
  async function change(action:()=>Promise<unknown>) {
    busy=true;error="";
    try {await action();notes=await api(`persons/${personId}/notes`);}
    catch(e) {
      const message=(e as Error).message;
      error=message.includes("NOTE_CONFLICT") ? "Запись изменилась в другом окне. Ваш текст сохранён в поле; откройте актуальную запись перед повторным сохранением." : message;
      if(message.includes("NOTE_CONFLICT")) {
        try {notes=await api(`persons/${personId}/notes`);} catch { /* Keep the conflict and draft visible when offline. */ }
      }
    } finally {busy=false;}
  }
</script>

<section aria-label="Заметки о человеке">
  <h3>Заметки</h3>
  <label>Новая заметка<textarea bind:value={draft} maxlength="10000" rows="3"></textarea></label>
  <button disabled={busy||!draft.trim()} onclick={()=>change(async()=>{await api(`persons/${personId}/notes`,{body:draft});draft="";})}>Добавить заметку</button>
  {#if error}<p role="alert">{error}</p>{/if}
  {#each notes as note (note.id)}
    <article>
      <div class="small muted">{date(note.created_at_ms)}{#if note.revision>0} · Изменено {date(note.updated_at_ms)}{/if}</div>
      {#if editing?.id===note.id}
        <label>Текст заметки<textarea bind:value={editBody} maxlength="10000" rows="3"></textarea></label>
        <button disabled={busy||!editBody.trim()} onclick={()=>change(async()=>{await api(`persons/${personId}/notes/${note.id}/update`,{body:editBody,revision:editing!.revision});editing=null;})}>Сохранить заметку</button>
        <button class="outline" disabled={busy} onclick={()=>editing=null}>Отмена</button>
      {:else}
        <p class="note-body">{note.body}</p>
        <button class="outline" disabled={busy} onclick={()=>{editing=note;editBody=note.body;}}>Редактировать заметку</button>
        <button class="outline" disabled={busy} onclick={()=>change(()=>api(`persons/${personId}/notes/${note.id}/delete`,{revision:note.revision}))}>Удалить заметку</button>
      {/if}
    </article>
  {/each}
</section>

<style>
  section {margin:1.5rem 0;}
  textarea {width:100%;box-sizing:border-box;resize:vertical;background:#101319;color:#e8e9ef;border:1px solid var(--border);border-radius:6px;padding:.7rem;font:inherit;}
  article {padding:1rem 0;border-bottom:1px solid var(--border);}
  .note-body {white-space:pre-wrap;overflow-wrap:anywhere;}
  button {margin:.5rem .5rem .5rem 0;}
</style>
