import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';
import {AnalyticsHistory} from '../src/analytics-history.js';
import {AnalyticsWorkspace} from '../src/analytics-workspace.js';
import {audienceAnalytics} from '../src/analytics.js';
import {streamFold,mergeHistory} from '../src/history-fold.js';
import {InsightAccumulator} from '../src/insights.js';
const at=Date.UTC(2026,0,1),minute=60000,day=86400000;
const query={fromMs:0,toMs:at+90*day,ownerId:'owner',timezone:'UTC',summaryOnly:true,includeInsights:true};
function seed(store:StreamStore,n=40){const ids:string[]=[];for(let i=0;i<n;i++){
 const start=at+i*day,id=store.startSession('owner',String(start),start,'platform',start);ids.push(id);
 store.streamSample(id,start,i%2?'irl':'game',i%2?'IRL':'Game','Title',i%8);
 for(let j=0;j<3;j++)store.recordPoll(id,'owner',{startedAtMs:start+j*minute,completedAtMs:start+(j+1)*minute,status:'complete',userIds:i%5?['viewer','other']:['viewer'],userNames:{viewer:'Viewer',other:'Other'}});
 store.ingest({source:'twitch',accountId:'owner',externalId:String(start),type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:start+minute,receivedAtMs:start+minute,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{}});
 store.endSession(id,start+4*minute);
 }return ids;}
function ready(h:AnalyticsHistory,q=query){let report;do{report=h.report(q);}while(report.preparing);return report;}
function legacy(store:StreamStore,q=query){const db=(store as any).db,h=new AnalyticsHistory(db),workspace=new AnalyticsWorkspace<any>(db);
 try{const iterator=(h as any).legacyAggregate(q,(h as any).sessions(q),audienceAnalytics(db,{...q,fromMs:q.toMs-1}),workspace);let next;do{next=iterator.next();}while(!next.done);return next.value;}finally{workspace.dispose();h.close();}
}
function comparable(report:any){const {clockRevision,...value}=report;void clockRevision;return value;}
test('persistent reductions agree with chronological folding, including clipping, filters, roles and unique membership',()=>{
 const s=new StreamStore(':memory:');try{
  seed(s,12);const h=(s as any).history as AnalyticsHistory;
  for(const source of ['all','twitch','youtube'] as const)for(const category of ['', 'game']){
   const q={...query,source,category,fromMs:at+minute/2,toMs:at+11*day+2*minute};
   assert.deepEqual(comparable(ready(h,q)),comparable(legacy(s,q)));
  }
  const first=ready(h),person=first.audience[0]!.id;
  s.followingSnapshot('twitch','owner',[{id:'viewer',name:'Viewer',followedAtMs:at}],true,at+20*day);
  s.setPersonMetadata(person,['friend'],false,s.personRevision(person));
  assert.deepEqual(comparable(ready(h)),comparable(legacy(s)));
 }finally{s.close();}
});
test('a changed stream updates one leaf after restart; new streams and late money never rebuild unchanged leaves',()=>{
 const dir=mkdtempSync(join(tmpdir(),'history-tree-')),path=join(dir,'data.sqlite');let s=new StreamStore(path);
 try{
  const ids=seed(s);ready((s as any).history);s.close();s=new StreamStore(path);
  const h=(s as any).history as AnalyticsHistory,tree=(h as any).tree,original=tree.reduce.bind(tree),rebuilt:string[]=[];
  tree.reduce=(root:any,tz:string,build:any)=>original(root,tz,(leaf:any,key:string)=>{rebuilt.push(leaf.id);return build(leaf,key);});
  s.streamSample(ids[20]!,at+20*day,'game','Game','Title',30);
  assert.deepEqual(comparable(ready(h)),comparable(legacy(s)));assert.deepEqual(rebuilt,[ids[20]]);rebuilt.length=0;
  const person=ready(h).audience[0]!.id;s.createDonation({personId:person,amount:'11',currency:'RUB',occurredAtMs:at+minute,message:'Late cash',sourceName:'Cash'},at+60*day);
  const corrected=ready(h);assert.deepEqual(corrected.audience.find(p=>p.id===person)!.donations,{RUB:'1100'});assert.deepEqual(rebuilt,[ids[0]]);rebuilt.length=0;
  const newer=at+50*day,id=s.startSession('owner','newer',newer,'platform',newer);s.streamSample(id,newer,'game','Game','New',7);s.endSession(id,newer+minute);
  assert.equal(ready(h).summary.streams,41);assert.deepEqual(rebuilt,[id]);
  assert.deepEqual(comparable(ready(h)),comparable(legacy(s)));
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('financial attribution follows corrected category geometry while unchanged money remains exact',()=>{
 const s=new StreamStore(':memory:');try{
  const [id]=seed(s,1),h=(s as any).history as AnalyticsHistory,p=ready(h).audience[0]!.id;
  s.createDonation({personId:p,amount:'6',currency:'RUB',occurredAtMs:at+2*minute,message:'',sourceName:'Cash'},at+2*minute);ready(h);
  s.streamSample(id!,at+minute,'irl','IRL','Title',5);
  const q={...query,sessionId:id!};assert.deepEqual(s.analytics(q).categories,audienceAnalytics((s as any).db,q).categories);
  assert.deepEqual(comparable(ready(h)),comparable(legacy(s)));
 }finally{s.close();}
});
test('insight states merge in order without changing return cohorts across subtree boundaries',()=>{
 const s=new StreamStore(':memory:');try{
  const ids=seed(s,10),db=(s as any).db,reports=ids.map(id=>audienceAnalytics(db,{...query,sessionId:id}));
  // The second participant first appears in the right subtree, then returns; an
  // earlier participant returning much later must not become a three-stream return.
  reports.forEach((r,i)=>{r.audience=r.audience.filter(p=>p.name!=='Viewer'||[0,7,8].includes(i));});
  const reference=new InsightAccumulator(new Map(),'UTC');reports.forEach(r=>reference.add(r,true));
  const pieces=[reports.slice(0,4),reports.slice(4,7),reports.slice(7)].map(rows=>{const a=new InsightAccumulator(new Map(),'UTC');rows.forEach(r=>a.add(r,true));return a.snapshot();});
  const merged=new InsightAccumulator(new Map(),'UTC');pieces.forEach(p=>merged.append(p));
  assert.deepEqual(merged.snapshot(),reference.snapshot());assert.deepEqual([...merged.find()],[...reference.find()]);
 }finally{s.close();}
});
test('damaged reductions rebuild from intact children; cache collection preserves leased roots and source facts',()=>{
 const s=new StreamStore(':memory:');try{
  seed(s,8);let h=(s as any).history as AnalyticsHistory;const first=ready(h),db=(s as any).db;
  const root=db.prepare('SELECT root FROM analytics_fold_roots LIMIT 1').get().root as string;
  db.prepare('UPDATE analytics_fold_nodes SET payload=? WHERE key=?').run(Buffer.from('broken'),root);db.prepare('DELETE FROM analytics_reports').run();h.close();h=new AnalyticsHistory(db);
  (h as any).build=()=>{throw Error('unchanged source projection rebuilt');};
  assert.deepEqual(comparable(ready(h)),comparable(first));
  const tree=(h as any).tree;tree.collect();
  db.prepare('DELETE FROM analytics_reports').run();db.prepare('DELETE FROM analytics_fold_roots').run();
  tree.writes=128;tree.collect([root]);assert.ok(db.prepare('SELECT 1 FROM analytics_fold_nodes WHERE key=?').get(root));
  assert.ok(db.prepare('SELECT count(*) n FROM analytics_fold_clock').get().n>0);
  tree.writes=128;tree.collect();assert.equal(db.prepare('SELECT count(*) n FROM analytics_fold_nodes').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM analytics_fold_clock').get().n,0);assert.equal(s.eventCount(),8);h.close();
 }finally{s.close();}
});

test('reductions own their mutable statistics and never alter a cached stream report',()=>{
 const s=new StreamStore(':memory:');try{const ids=seed(s,2),db=(s as any).db;
  const reports=ids.map(id=>audienceAnalytics(db,{...query,sessionId:id})),before=structuredClone(reports);
  mergeHistory(streamFold(reports[0]!, 'UTC'),streamFold(reports[1]!, 'UTC'),'UTC');assert.deepEqual(reports,before);
 }finally{s.close();}
});
