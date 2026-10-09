<script lang="ts">
  import {api,date} from './api';
  let {status}:{status:any}=$props();
  type File={filename:string;size:number;createdAt:number};
  let directory=$state(''),files=$state<File[]>([]),busy=$state(false),error=$state('');
  const channelLabel=(value:any)=>value?.state==='success'?'Сохранена':value?.state==='error'?'Ошибка':value?.state==='disabled'?'Не настроено':'Пока нет подтверждённой копии';
  $effect(()=>{const local=status.local?.lastSuccessAt,cloud=status.cloud?.state;void local;void cloud;void refresh();});
  async function refresh(){
    busy=true;error='';
    try {const data=await api<{directory:string;files:File[]}>('backups');directory=data.directory;files=data.files;}
    catch(e){error=(e as Error).message==='BACKUP_NOT_CONFIGURED'?'Резервное копирование на сервере не настроено':(e as Error).message;}
    finally{busy=false;}
  }
</script>

<div aria-label="Файлы резервных копий">
  <div class="channels">
    <div><strong>Локальная копия</strong><span>{channelLabel(status.local)}</span>{#if status.local?.lastSuccessAt}<small>{date(status.local.lastSuccessAt)}</small>{/if}</div>
    <div><strong>Облачная копия</strong><span>{channelLabel(status.cloud)}</span>{#if status.cloud?.lastSuccessAt}<small>{date(status.cloud.lastSuccessAt)}</small>{/if}</div>
  </div>
  {#if directory}<div>Каталог на сервере<code>{directory}</code></div>{/if}
  <button class="outline" disabled={busy} onclick={refresh}>Обновить список копий</button>
  {#if error}<p role="alert">{error}</p>{/if}
  {#each files as file}
    <article><div><strong>{date(file.createdAt)}</strong><small>{file.filename}</small><small>{(file.size/1024).toFixed(1)} КБ</small></div><a class="outline" href={`/api/v1/backups/${encodeURIComponent(file.filename)}`} download={file.filename}>Скачать копию</a></article>
  {/each}
  {#if !busy&&!error&&!files.length}<p class="small muted">Сохранённых файлов пока нет</p>{/if}
</div>

<style>
  .channels{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin:1rem 0;}
  .channels div,article div{display:flex;flex-direction:column;gap:.4rem;}
  code,small{overflow-wrap:anywhere;white-space:normal;}
  code{display:block;margin:.5rem 0;}
  article{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 0;border-bottom:1px solid var(--border);}
  article div{min-width:0;flex:1 1 200px;}
  a{white-space:nowrap;}
</style>
