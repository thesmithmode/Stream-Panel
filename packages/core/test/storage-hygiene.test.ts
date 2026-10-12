import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {StreamStore} from '../src/store.js';
test('identical diagnostic snapshots retain first and latest observations; unique fields and follower/chat evidence stay intact',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-snapshot-hygiene-')),path=join(dir,'data.sqlite');const s=new StreamStore(path,'ruslan');const read=new Database(path);
 try{for(let i=0;i<100;i++)s.providerSnapshot('donationalerts','da','donation_history_page',{page:1,response:{data:[{id:1,amount:'228',future:'keep'}]}},1000+i);
 const rows=read.prepare('SELECT * FROM p_ruslan_provider_snapshots ORDER BY observed_at_ms').all() as any[];assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.observed_at_ms),[1000,1099]);assert.equal(JSON.parse(rows[0].payload_json).response.data[0].future,'keep');
 s.providerSnapshot('donationalerts','da','donation_history_page',{page:2,response:{data:[{id:1,amount:'228',future:'keep'}]}},1100);
 s.providerSnapshot('donationalerts','da','donation_history_page',{page:1,response:{data:[{id:1,amount:'228',future:'new'}]}},1101);
 for(let i=0;i<5;i++)s.providerSnapshot('twitch','owner','followers',{followers:[],complete:true},1200+i);
 assert.equal((read.prepare("SELECT count(*) n FROM p_ruslan_provider_snapshots WHERE key='followers'").get() as any).n,5);assert.equal((read.prepare("SELECT count(*) n FROM p_ruslan_provider_snapshots WHERE key='donation_history_page'").get() as any).n,4);
 }finally{read.close();s.close();await rm(dir,{recursive:true,force:true});}
});
