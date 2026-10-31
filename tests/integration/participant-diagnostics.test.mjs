import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {StreamStore} from '../../dist/packages/core/src/store.js';

test('production participant probe distinguishes persisted inputs and calculated participants without changing data or exposing identities',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-participant-probe-')),path=join(dir,'data.sqlite');
 const start=Date.UTC(2026,9,30,20,19),end=start+5*60000;
 try{
  for(const profile of ['ruslan','gulnaz']){
   const store=new StreamStore(path,profile);
   try{
    const id=store.observePlatformStream('twitch','private-owner','stream',start,start,null,'Private stream title');
    store.ensureOwnerIdentity('private-owner','private-owner','private_owner_name',start);
    store.recordPoll(id,'private-owner',{startedAtMs:start,completedAtMs:start+60000,status:'complete',userIds:['private-owner','private-guest'],userNames:{'private-guest':'Private guest name'}});
    store.recordPoll(id,'private-owner',{startedAtMs:start+60000,completedAtMs:start+120000,status:'failed',userIds:[]});
    store.endSession(id,end);
    store.analytics({fromMs:start,toMs:end,sessionId:id,ownerId:'private-owner'});
   }finally{store.close();}
   mkdirSync(join(dir,'profiles',profile),{recursive:true});
   writeFileSync(join(dir,'profiles',profile,'secrets.json'),JSON.stringify({twitch:{userId:'private-owner',access:'secret-do-not-output'},excludedBotLogins:[]}));
  }
  const hash=()=>createHash('sha256').update(readFileSync(path)).digest('hex'),before=hash();
  const script=readFileSync(new URL('../../ops/diagnose-streams.py',import.meta.url),'utf8').match(/node_program=r'''([\s\S]*?)'''/)[1];
  const result=spawnSync(process.execPath,['--input-type=module','-e',script,path],{cwd:new URL('../..',import.meta.url),encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(hash(),before,'diagnostics must not mutate the database');
  assert.doesNotMatch(result.stdout,/private-owner|private-guest|private_owner_name|Private guest name|Private stream title|secret-do-not-output/);
  const records=prefix=>result.stdout.split('\n').filter(line=>line.startsWith(prefix+'=')).map(line=>JSON.parse(line.slice(prefix.length+1)));
  const inputs=records('participant_inputs');
  assert.equal(inputs.length,2);
  for(const row of inputs){assert.equal(row.people.people,2);assert.equal(row.people.owners,1);assert.equal(row.polls.find(p=>p.status==='complete').memberships,2);assert.equal(row.polls.find(p=>p.status==='failed').emptyPolls,1);}
  for(const row of records('participant_calculation')){assert.equal(row.participants,1);assert.equal(row.observedParticipants,1);assert.ok(row.observedMinutes>0);}
  assert.equal(records('participant_calculation').length,2);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
