<script lang="ts">
 import {api,getProfile} from './api';
 import {onDestroy} from 'svelte';
 import {confirmAction} from './confirmation.svelte';
 let {personId,onChange}:{personId:string;onChange:()=>Promise<void>}=$props();
 let name=$state(''),bindings=$state<any[]>([]),nicknames=$state<any[]>([]),revision=$state(0),busy=$state(false),error=$state(''),message=$state('');
 const listId=$props.id();let generation=0;const profile=getProfile();onDestroy(()=>generation++);
 async function load(){const id=personId,token=++generation;const [person,links,names]=await Promise.all([api(`persons/${id}?events=false`),api(`persons/${id}/donor-bindings`),api('donor-nicknames')]);if(token!==generation||id!==personId||getProfile()!==profile)return;revision=person.revision;bindings=links;nicknames=names;}
 $effect(()=>{void personId;void load().catch(e=>error=e.message);});
 async function bind(){const id=personId,nickname=name,version=revision;if(!await confirmAction('Привязать все донаты?',`Только в профиле «${profile==='ruslan'?'Руслан':'Гульназ'}»: прошлые и будущие донаты с ником «${nickname.trim()}» будут связаны с этим человеком.`))return;if(profile!==getProfile()||id!==personId){error='Профиль или человек изменился. Откройте привязку заново.';return;}busy=true;error='';message='';try{bindings=await api(`persons/${id}/donor-bindings`,{name:nickname,revision:version});name='';await load();await onChange();message='Ник привязан: прошлые и будущие донаты относятся к этому человеку.';}catch(e){error=(e as Error).message==='REVISION_CONFLICT'?'Данные изменились. Обновите привязки и повторите.':(e as Error).message;}finally{busy=false;}}
</script>
<section class="donor-links" aria-label="Привязка ника донатера"><h3>Ники донатера</h3>
 <p class="small muted">Привязка действует только в текущем профиле и использует его источник DonationAlerts. В другом профиле этот ник привязывается независимо. </p>
 <form onsubmit={e=>{e.preventDefault();void bind();}}><label>Ник в DonationAlerts<input list={listId} bind:value={name} maxlength="200" required placeholder="Введите или выберите ник" autocomplete="off"/><datalist id={listId}>{#each nicknames as n}<option value={n.name}></option>{/each}</datalist></label><button class="primary" disabled={busy||!name.trim()}>Привязать все донаты</button></form>
 {#each bindings as b}<p class="small">{b.name} · привязан к этому человеку</p>{/each}
 {#if message}<p class="small" role="status">{message}</p>{/if}{#if error}<p role="alert" class="notice error">{error}</p><button class="outline" onclick={()=>void load().then(()=>error='').catch(e=>error=e.message)}>Обновить привязки</button>{/if}
</section>
<style>.donor-links{margin:0 0 20px;padding-bottom:16px;border-bottom:1px solid var(--border);}form{display:flex;gap:10px;align-items:end;flex-wrap:wrap;}label{display:grid;gap:6px;flex:1 1 200px;font-size:12px;}input{width:100%;min-width:0;}button{min-height:42px;}</style>
