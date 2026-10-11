<script lang="ts">
 import {api,importBackup,getDataMode} from './api';
 let {available}:{available:boolean}=$props();
 let files=$state<FileList>(),key=$state(''),confirmed=$state(false),busy=$state(false),error=$state(''),message=$state(''),imported=$state(false);
 async function downloadKey(){
  busy=true;error='';
  try{const result=await api<{key:string}>('backup/key',{});const url=URL.createObjectURL(new Blob([result.key+'\n'],{type:'text/plain'}));const link=document.createElement('a');link.href=url;link.download='stream-panel-backup.key';link.click();URL.revokeObjectURL(url);message='Ключ скачан. Храните его вместе с резервной копией вне сервера.';}
  catch(e){error=(e as Error).message;}finally{busy=false;}
 }
 async function restore(){
  busy=true;error='';message='';
  try{await importBackup(files![0]!,key.trim());imported=true;key='';files=undefined;confirmed=false;message='Копия проверена. Сервис перезапускается. Войдите с паролем из резервной копии.';}
  catch(e){const code=(e as Error).message;error=code==='BACKUP_INVALID'?'Не удалось проверить копию. Текущая база не изменена.':code==='INVALID_BACKUP_KEY'?'Ключ должен содержать 64 шестнадцатеричных символа.':code;}
  finally{busy=false;}
 }
</script>
<div class="restore" aria-label="Восстановление резервной копии">
 <button class="outline" disabled={busy||getDataMode()==='demo'||imported} onclick={downloadKey}>Скачать ключ восстановления</button>
 <details><summary>Импорт резервной копии</summary>
  <p class="small">Восстановятся история, пользователи и подключения обоих профилей. Перед заменой сервис сохранит текущую базу в отдельную копию.</p>
  <label>Файл резервной копии<input type="file" accept=".spbk" bind:files disabled={busy||!available||imported}/></label>
  <label>Ключ восстановления<input type="password" bind:value={key} autocomplete="off" placeholder="Оставьте пустым для копии с этого сервера" disabled={busy||!available||imported}/></label>
  <label class="check"><input type="checkbox" bind:checked={confirmed} disabled={busy||!available||imported}/> Заменить текущие данные данными копии</label>
  <button class="primary" disabled={busy||!available||!files?.length||!confirmed||imported||getDataMode()==='demo'} onclick={restore}>{busy?'Проверяем копию…':'Импортировать резервную копию'}</button>
 </details>
 {#if error}<p role="alert">{error}</p>{/if}{#if message}<p role="status">{message}</p>{/if}
 {#if imported}<button class="outline" onclick={()=>location.reload()}>Открыть панель</button>{/if}
</div>
<style>.restore{margin-top:1.5rem;}details{margin-top:1rem;}input{max-width:100%;}p{overflow-wrap:anywhere;}</style>
