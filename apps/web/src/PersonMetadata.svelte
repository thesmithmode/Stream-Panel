<script lang="ts">
  import {api,getDataMode} from './api';
  import Help from './Help.svelte';
  let {personId,onChange}: {personId:string;onChange:()=>Promise<void>}=$props();
  type Metadata={revision:number;tags:string[];manualCore:boolean|null};
  let metadata=$state<Metadata|null>(null),tags=$state<string[]>([]),tag=$state(''),core=$state('auto'),busy=$state(false),error=$state('');
  $effect(()=>{
    const id=personId;let cancelled=false;
    void api<Metadata>(`persons/${id}/metadata`).then(value=>{if(!cancelled){metadata=value;tags=value.tags;core=value.manualCore===null?'auto':value.manualCore?'include':'exclude';}}).catch(e=>{if(!cancelled)error=e.message;});
    return ()=>{cancelled=true;};
  });
  function addTag(){const value=tag.trim();if(value&&!tags.includes(value)&&tags.length<50)tags=[...tags,value];tag='';}
  async function save(){
    if(!metadata)return;
    busy=true;error='';
    try {addTag();metadata=await api(`persons/${personId}/metadata`,{tags,manualCore:core==='auto'?null:core==='include',revision:metadata.revision});tags=metadata!.tags;await onChange();}
    catch(e){error=(e as Error).message.includes('REVISION_CONFLICT')?'Карточка изменилась в другом окне. Ваши настройки сохранены в форме. Загрузите актуальные перед повторным сохранением.':(e as Error).message;}
    finally{busy=false;}
  }
  async function reload(){
    busy=true;error='';
    try {metadata=await api(`persons/${personId}/metadata`);tags=metadata!.tags;core=metadata!.manualCore===null?'auto':metadata!.manualCore?'include':'exclude';tag='';}
    catch(e){error=(e as Error).message;}finally{busy=false;}
  }
</script>

<section aria-label="Метки человека">
  <h3>Метки <Help id="person-core-help" label="Как определяется ядро" text="Автоматически учитываются посещаемость и активность за выбранный период. Ручная отметка действует во всех отчётах профиля. Владельцы и боты исключаются независимо от отметки." /></h3>
  <label>Ядро аудитории<select aria-label="Ядро аудитории" bind:value={core} disabled={busy||!metadata}><option value="auto">Определять автоматически</option><option value="include">Включить в ядро</option><option value="exclude">Исключить из ядра</option></select></label>
  <label>Новый тег<div class="inline"><input bind:value={tag} maxlength="64" disabled={busy||!metadata} onkeydown={e=>{if(e.key==='Enter'){e.preventDefault();addTag();}}}/><button class="outline" disabled={busy||!metadata||!tag.trim()||tags.length>=50} onclick={addTag}>Добавить тег</button></div></label>
  <div class="tags">{#each tags as label}<span>{label}<button class="text-button" aria-label={`Удалить тег ${label}`} disabled={busy} onclick={()=>tags=tags.filter(t=>t!==label)}>×</button></span>{/each}</div>
  <button class="primary" disabled={busy||!metadata||getDataMode()==='demo'} onclick={save}>Сохранить метки</button>
  {#if error}<p role="alert">{error}</p><button class="outline" disabled={busy} onclick={reload}>Загрузить актуальные метки</button>{/if}
</section>

<style>
  section{margin:1.5rem 0;}
  .tags{display:flex;flex-wrap:wrap;gap:.5rem;margin:.75rem 0;}
  .tags span{display:inline-flex;align-items:center;gap:.4rem;border:1px solid var(--border);border-radius:6px;padding:.3rem .6rem;overflow-wrap:anywhere;max-width:100%;}
</style>
