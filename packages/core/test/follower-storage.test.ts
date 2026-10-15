import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openProfileDatabase} from '../src/profile-db.js';import {schemaMigrations} from '../src/schema.js';import {StreamStore} from '../src/store.js';
test('migration shares equal follower payloads while preserving every timestamp and both profiles',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-follower-migration-')),path=join(dir,'data.sqlite');
 try{for(const profile of ['ruslan','gulnaz']){
 const old=openProfileDatabase(path,profile);for(const sql of schemaMigrations.slice(0,16))old.exec(sql);
 old.prepare("INSERT INTO sessions VALUES ('stream','owner','one','platform',1000,1000,10000,'observed')").run();
 for(let i=0;i<50;i++)old.prepare('INSERT INTO provider_snapshots VALUES (?,?,?,?,?,?,?)').run('poll-'+i,'twitch','owner','followers',1001+i,'stream',JSON.stringify({followers:i%2?[{id:'b',name:'B',followedAtMs:1000},{id:'a',name:'A',followedAtMs:1000}]:[{id:'a',name:'A',followedAtMs:1000},{id:'b',name:'B',followedAtMs:1000}],complete:true,total:2}));old.close();
 const s=new StreamStore(path,profile),db=(s as any).db;assert.equal(db.prepare('SELECT count(*) n FROM provider_snapshots').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM follower_checks').get().n,50);
 assert.deepEqual(s.followingAnalytics('stream').polls.map(p=>p.at),Array.from({length:50},(_,i)=>1001+i));
 s.followingSnapshot('twitch','owner',[{id:'a',name:'Renamed',followedAtMs:1000}],false,10000);assert.equal(db.prepare('SELECT count(*) n FROM provider_snapshots').get().n,2);assert.equal(db.prepare('SELECT count(*) n FROM follower_checks').get().n,51);s.close();
 }}finally{await rm(dir,{recursive:true,force:true});}
});
