import assert from 'node:assert/strict';
import {StreamStore} from '../dist/packages/core/src/store.js';
import {latestFollowerSnapshotsSql,streamFollowerObservationsSql} from '../dist/packages/core/src/follower-queries.js';
// Reproducible, synthetic before/after comparison. No production database access.
// node scripts/build-core.mjs && node scripts/benchmark-follower-queries.mjs 1660 1
const count=Number(process.argv[2]??1660),variants=Number(process.argv[3]??1);
if(!Number.isInteger(count)||count<1||count>5000||!Number.isInteger(variants)||variants<1||variants>count)throw Error('Expected 1–5000 checks and 1–checks distinct payloads');
const store=new StreamStore(':memory:'),db=store.db,base=Date.UTC(2026,9,1),minute=60000;
const legacyStream="SELECT source,account_id AS account,observed_at_ms AS at,payload_json FROM follower_observations p WHERE key='followers' AND ((observed_at_ms>=? AND observed_at_ms<=?) OR id=(SELECT q.id FROM follower_observations q WHERE q.source=p.source AND q.account_id=p.account_id AND q.key='followers' ORDER BY q.observed_at_ms DESC,q.id DESC LIMIT 1)) ORDER BY observed_at_ms";
const legacyAggregate="SELECT p.source,p.account_id,p.payload_json FROM follower_observations p WHERE p.id=(SELECT q.id FROM follower_observations q WHERE q.source=p.source AND q.account_id=p.account_id ORDER BY q.observed_at_ms DESC,q.id DESC LIMIT 1)";
const legacyRaw="SELECT p.source,p.account_id,p.payload_json FROM follower_observations p WHERE key='followers' AND id=(SELECT q.id FROM follower_observations q WHERE q.source=p.source AND q.account_id=p.account_id AND q.key='followers' ORDER BY observed_at_ms DESC,id DESC LIMIT 1)";
try{
 const followers=Array.from({length:40},(_,i)=>({id:String(i),name:`Viewer ${i}`,followedAtMs:base+minute+i}));
 db.transaction(()=>{for(let n=0;n<count;n++)store.followingSnapshot('twitch','owner',followers,true,base+n*minute,40+n%variants);})();
 const median=(run)=>{const values=Array.from({length:5},()=>{const at=performance.now();run();return performance.now()-at;}).sort((a,b)=>a-b);return Math.round(values[2]*100)/100;};
 for(const [name,before,after,args] of [['streamFollowers',legacyStream,streamFollowerObservationsSql,[base,base+10*minute]],['aggregateFollowers',legacyAggregate,latestFollowerSnapshotsSql,[]],['rawFollowers',legacyRaw,latestFollowerSnapshotsSql,[]]]){
  const oldQuery=db.prepare(before),newQuery=db.prepare(after);
  assert.deepEqual(newQuery.all(...args),oldQuery.all(...args));
  console.log(JSON.stringify({name,checks:count,payloads:variants,beforeMs:median(()=>oldQuery.all(...args)),afterMs:median(()=>newQuery.all(...args)),identicalResults:true}));
 }
}finally{store.close();}
