import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {activatePendingRestore,stageRestore,commitRestore} from '../src/restore-service.js';
import {BackupService} from '../src/backup.js';
import {AccountStore} from '../src/auth.js';
import {StreamStore} from '../../../packages/core/src/store.js';
const at=Date.UTC(2026,9,29,12);
const chat=(s:StreamStore,user:string,name:string)=>s.ingest({source:'twitch',accountId:'owner',externalId:`${user}-${name}`,type:'chat.message',actor:{externalId:user,displayName:name},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hi'}}).personId!;
const youtube=(s:StreamStore,channel:string,name:string)=>{s.youtubeMessages('yt','chat',[{id:`${channel}-message`,snippet:{type:'textMessageEvent',publishedAt:new Date(at).toISOString(),displayMessage:'hi'},authorDetails:{channelId:channel,displayName:name}}]);return `youtube:${channel}`;};

test('a backup carries the shared account groups and a restore keeps them for both profiles',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-shared-backup-')),source=join(dir,'source'),target=join(dir,'target'),key=join(dir,'key');await mkdir(source);await mkdir(target);await writeFile(key,'c'.repeat(64));
 const accounts=new AccountStore(join(source,'data.sqlite')),a=new StreamStore(join(source,'data.sqlite'),'ruslan'),b=new StreamStore(join(source,'data.sqlite'),'gulnaz'),backup=new BackupService(source,{keyFile:key});
 try{
  await accounts.createUser('ruslan','ruslan','Руслан','shared-backup-password');
  const tw=chat(a,'100','chikist007'),yt=youtube(a,'UCegor','@egorbarinov');a.merge(yt,tw,a.personRevision(yt),a.personRevision(tw),at);
  const bTw=chat(b,'100','chikist007');youtube(b,'UCegor','@egorbarinov');
  assert.equal((b.person(bTw).identities as any[]).length,2,'a late YouTube account joins its shared group');
  const file=join(dir,'input.spbk');await writeFile(file,await backup.file((await backup.run()).filename));
  const stage=join(dir,'staged');await stageRestore(file,Buffer.from('c'.repeat(64),'hex'),stage);
  await commitRestore(target,stage);assert.equal(await activatePendingRestore(target),true);
 }finally{await backup.stop();a.close();b.close();accounts.close();}
 const raw=new Database(join(target,'data.sqlite'),{readonly:true});
 try{
  assert.deepEqual(raw.prepare('SELECT link_key FROM sp_identity_links ORDER BY link_key').all(),[{link_key:'twitch:100'},{link_key:'youtube:UCegor'}]);
  assert.deepEqual(raw.prepare('SELECT profile FROM sp_identity_sync_profiles ORDER BY profile').all(),[{profile:'gulnaz'},{profile:'ruslan'}]);
 }finally{raw.close();}
 const restored=new StreamStore(join(target,'data.sqlite'),'gulnaz');
 try{
  assert.equal(restored.persons().length,1);assert.deepEqual(restored.syncSharedIdentities(),[]);
  // A merge undone after the restore still reaches the other profile.
  const peer=new StreamStore(join(target,'data.sqlite'),'ruslan');
  try{peer.undoMerge(String(peer.merges()[0]!.id),at+1);assert.equal(restored.persons().length,2);}finally{peer.close();}
 }finally{restored.close();await rm(dir,{recursive:true,force:true});}
});
