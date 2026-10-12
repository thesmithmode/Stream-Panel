<script lang="ts">
 import {api} from './api';
 let {personId,onChange}:{personId:string;onChange:()=>Promise<void>}=$props();
 let name=$state(''),bindings=$state<any[]>([]),nicknames=$state<any[]>([]),revision=$state(0),busy=$state(false),error=$state(''),message=$state('');
 const listId=$props.id();
 async function load(){const [person,links,names]=await Promise.all([api(`persons/${personId}?events=false`),api(`persons/${personId}/donor-bindings`),api('donor-nicknames')]);revision=person.revision;bindings=links;nicknames=names;}
 $effect(()=>{void personId;void load().catch(e=>error=e.message);});
 async function bind(){busy=true;error='';message='';try{bindings=await api(`persons/${personId}/donor-bindings`,{name,revision});name='';await load();await onChange();message='Ник привязан: прошлые и будущие донаты относятся к этому человеку.';}catch(e){error=(e as Error).message==='REVISION_CONFLICT'?'Данные изменились. Обновите привязки и повторите.':(e as Error).message;}finally{busy=false;}}
</script>
<section class="donor-links" aria-label="Привязка ника донатера"><h3>Ники донатера</h3>
 <p class="small muted">Все прошлые и будущие донаты с этим ником будут относиться к человеку. Совпадающие ники связываются автоматически, когда найден один подходящий аккаунт.</p>
 <form onsubmit={e=>{e.preventDefault();void bind();}}><label>Ник в DonationAlerts<input list={listId} bind:value={name} maxlength="200" required placeholder="Введите или выберите ник" autocomplete="off"/><datalist id={listId}>{#each nicknames as n}<option value={n.name}></option>{/each}</datalist></label><button class="primary" disabled={busy||!name.trim()}>Привязать все донаты</button></form>
 {#each bindings as b}<p class="small">{b.name} · привязан к этому человеку</p>{/each}
 {#if message}<p class="small" role="status">{message}</p>{/if}{#if error}<p role="alert" class="notice error">{error}</p><button class="outline" onclick={()=>void load().then(()=>error='').catch(e=>error=e.message)}>Обновить привязки</button>{/if}
</section>
<style>.donor-links{margin:0 0 20px;padding-bottom:16px;border-bottom:1px solid var(--border);}form{display:flex;gap:10px;align-items:end;flex-wrap:wrap;}label{display:grid;gap:6px;flex:1 1 200px;font-size:12px;}input{width:100%;min-width:0;}button{min-height:42px;}</style>
