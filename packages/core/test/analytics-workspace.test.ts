import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3';import {AnalyticsWorkspace,DiskMap} from '../src/analytics-workspace.js';
const person=(id:string,core=false)=>({id,name:`Viewer ${id}`,core,sources:['twitch'],messages:Number(id),observedMinutes:Number(id),sessionCount:1});
test('workspace pages exact people and deduplicates category and clock membership without a heap-sized map',()=>{
 const db=new Database(':memory:');db.pragma('temp_store=FILE');const w=new AnalyticsWorkspace<ReturnType<typeof person>>(db);
 try{
  assert.equal(w.people.get('missing'),undefined);
  for(let i=0;i<135;i++){const p=person(String(i),i%2===0);w.people.set(p.id,p);w.categoryPerson('game',p.id);w.categoryPerson('game',p.id);}
  assert.equal(w.people.size,135);assert.equal([...w.people.values()].length,135);assert.equal(w.people.page(100).items.length,35);assert.equal(w.people.page(0,'134','messages').total,1);
  w.people.set('ru',{...person('ru'),name:'Руслан'});assert.equal(w.people.page(0,'РУСЛАН').total,1);
  for(const sort of ['sessions','messages','observedMinutes','estimatedChatMinutes','attendanceRatio'])assert.equal(w.people.page(0,'',sort,true).total,68);
  assert.equal(w.people.firstVisit('1'),true);w.people.set('1',person('1'));assert.equal(w.people.firstVisit('1'),false);
  assert.deepEqual(w.categoryCounts('game'),{audience:135,core:68});assert.deepEqual(w.categoryCounts('none'),{audience:0,core:0});
  const b=(day:string,minute:number,resolution=1)=>({day,minute,resolution,streams:1,airtimeMs:60000,personTimeMs:60000,averageAudience:1,people:[{id:'1',visits:1}]});
  w.addClock('first',[b('all',0),b('пн',0),b('пн',1),b('пн',3),b('пн',5,5)]);w.addClock('second',[b('пн',1),b('сб',1)]);
  assert.equal(w.clockPage('all',0,5).items[0]!.visits,2);assert.equal(w.clockPage('weekdays',1,1).items[0]!.visits,2);assert.equal(w.clockPage('weekends',1,1).items[0]!.visits,1);assert.equal(w.clockPage('пн',2,1).total,0);assert.equal(w.clockPage('пн',0,5,100).items.length,0);
  w.checkBudget();const original=db.pragma.bind(db);db.pragma=((sql:string,opts?:Database.PragmaOptions)=>sql==='temp.page_count'?1000000:original(sql,opts)) as typeof db.pragma;assert.throws(()=>w.checkBudget(),/ANALYTICS_WORKSPACE_LIMIT/);db.pragma=original;
 }finally{w.dispose();w.dispose();db.close();}
});
test('low-disk workspace expansion fails without touching factual tables',()=>{
 const db=new Database(':memory:'),proxy=new Proxy(db,{get(target,key){if(key==='name')return '/proc/self';const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
 const w=new AnalyticsWorkspace(proxy);assert.throws(()=>w.checkBudget(),/ANALYTICS_DISK_RESERVE/);w.dispose();const map=new DiskMap(db,'standalone_map');assert.deepEqual([...map.values()],[]);db.close();
});
