import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AccountStore} from '../src/auth.js';
import {resetLocalPassword} from '../src/password.js';
import {StreamStore} from '../../../packages/core/src/store.js';
test('password reset backs up history first, keeps other users/keys, revokes only its sessions and never stores invalid passwords',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-password-')),path=join(dir,'data.sqlite'),a=new AccountStore(path),s=new StreamStore(path,'ruslan');
 try {
 await a.createUser('ruslan','ruslan','Руслан','original-password');await a.createUser('gulnaz','gulnaz','Гульназ','gulnaz-password');
 const r=await a.login('ruslan','original-password','ip'),g=await a.login('gulnaz','gulnaz-password','ip');
 s.startSession('owner','stream',1,'platform',1);
 await mkdir(join(dir,'profiles/ruslan'),{recursive:true});await writeFile(join(dir,'profiles/ruslan/secrets.json'),'{"version":1,"daClientSecret":"fixture"}');
 await assert.rejects(resetLocalPassword(dir,'short'),/INVALID_PASSWORD/);
 await assert.rejects(resetLocalPassword(dir,'new-long-password'),/BACKUP_FAILED/);
 assert.ok(await a.login('ruslan','original-password','ip'));
 await writeFile(join(dir,'backup-key'),'a'.repeat(64));await resetLocalPassword(dir,'new-long-password');
 assert.equal(await a.login('ruslan','original-password','ip'),null);assert.ok(await a.login('ruslan','new-long-password','ip'));
 assert.equal(a.session(`sp_session=${r!.token}`),null);assert.ok(a.session(`sp_session=${g!.token}`));
 assert.equal(s.sessions().length,1);assert.match(await readFile(join(dir,'profiles/ruslan/secrets.json'),'utf8'),/fixture/);
 assert.equal((await readdir(join(dir,'backups'))).filter(x=>x.endsWith('.spbk')).length,1);
 await assert.rejects(a.resetPassword('unknown','valid-long-password'),/INVALID_PROFILE/);
 await assert.rejects(a.resetPassword('ruslan','short'),/INVALID_PASSWORD/);
 const missing=new AccountStore(join(dir,'missing.sqlite'));try{await assert.rejects(missing.resetPassword('ruslan','valid-long-password'),/USER_NOT_FOUND/);}finally{missing.close();}
 }finally{s.close();a.close();await rm(dir,{recursive:true,force:true});}
});
