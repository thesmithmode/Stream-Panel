import test from 'node:test';
import assert from 'node:assert/strict';
import {InsightAccumulator,type InsightPerson} from '../src/insights.js';
import {StreamStore} from '../src/store.js';
const minute=60000,day=86400000,base=Date.UTC(2026,7,1,14); // Saturday 17:00 Moscow
function person(id='quiet',messages=0,donation='0',from=60,to=120){return {id,name:id,sources:['twitch'],observedMinutes:to-from,messages,donations:donation==='0'?{}:{RUB:donation},intervals:[{from:base+from*minute,to:base+to*minute,kind:'observed'}],messageMinutes:messages?[{at:base+from*minute}]:[]};}
function report(n:number,opts:{people?:ReturnType<typeof person>[];category?:string;duration?:number;known?:boolean;live?:boolean;viewers?:number;late?:number;source?:string;start?:number}={}){
 const start=opts.start??base+n*7*day,duration=opts.duration??120,end=start+duration*minute,shift=start-base,people=structuredClone(opts.people??[person('quiet',0,'100'),person('supporter',0,'10')]);
 for(const p of people){for(const i of p.intervals){i.from+=shift;i.to+=shift;}for(const m of p.messageMinutes)m.at+=shift;}
 const timeline=Array.from({length:duration},(_,i)=>({at:start+i*minute,presenceKnown:opts.known!==false,isBreak:false,viewers:opts.viewers===0?null:(i<60?opts.viewers??4:opts.late??10),viewersPartial:false}));
 const category=opts.category??'dota',hours=[];for(let i=0;i<duration;i+=60){const date=new Date(start+i*minute),day=['вс','пн','вт','ср','чт','пт','сб'][date.getUTCDay()];hours.push({day,hour:(date.getUTCHours()+3)%24,donationCount:i===60&&people.some(p=>Object.keys(p.donations).length)?1:0});}
 return {sessions:[{ended_at_ms:opts.live?null:end}],filters:{source:opts.source??'all'},activityWindows:[{from:start,to:end,categoryId:category}],streamComparison:[{id:`s${n}`,startedAt:start,endedAt:end,durationMs:duration*minute,messages:people.reduce((sum,p)=>sum+p.messages,0),title:`Эфир ${n}`,viewers:{all:{mean:opts.viewers===0?null:opts.viewers??7,coverageRatio:opts.viewers===0?0:1}}}],timeline,hours,categories:[{id:category,name:category,minutes:duration,messages:people.reduce((sum,p)=>sum+p.messages,0)}],audience:people} as any;
}
function engine(focus=''){return new InsightAccumulator(new Map<string,InsightPerson>(),'Europe/Moscow',focus);}
const collect=(e:InsightAccumulator)=>[...e.find()].filter(c=>c!==undefined);
const kinds=(e:InsightAccumulator)=>new Set(collect(e).map(c=>c.kind));
test('recurring silent participants, habitual donor hours, strong slots and support concentration retain evidence without a card cap',()=>{
 const e=engine();for(let i=0;i<6;i++)e.add(report(i),true,[{personId:'quiet',at:base+i*7*day+65*minute},{personId:'supporter',at:base+i*7*day+70*minute}]);
 const cards=collect(e),found=new Set(cards.map(c=>c.kind));
 for(const kind of ['silent_regular','person_schedule','strong_hour','donor_window','support_concentration'])assert.ok(found.has(kind),kind);
 assert.ok(cards.some(c=>c.group==='support'));assert.ok(cards.some(c=>c.detail.includes('6 из 6')));assert.ok(cards.every(c=>c.evidence.length&&c.basis&&c.action&&c.sampleSize>0));
 const many=engine();for(let i=0;i<5;i++)many.add(report(i,{people:Array.from({length:45},(_,j)=>person(`p${j}`))}),true);
 assert.equal(collect(many).filter(c=>c.kind==='silent_regular').length,45);
});
test('category affinity compares actual opportunities and category-level audience requires repeated measurements',()=>{
 const e=engine();for(let i=0;i<12;i++)e.add(report(i,{category:i<6?'wow':'dota',people:i<6?[person('fan',2,'0',0,120)]:[],viewers:i<6?20:5,late:i<6?20:5}),true);
 const cards=collect(e);assert.ok(cards.some(c=>c.kind==='person_category'&&c.personId==='fan'));assert.ok(cards.some(c=>c.kind==='category_audience'));
});
test('regular absence requires five complete closed opportunities in familiar hours; activity changes need six qualified visits',()=>{
 const missing=engine();for(let i=0;i<10;i++)missing.add(report(i,{people:i<5?[person('missing',10,'0',0,120)]:[]}),true);
 assert.ok(kinds(missing).has('missing_regular'));
 const changed=engine();for(let i=0;i<6;i++)changed.add(report(i,{people:[person('changed',i<3?5:0,'0',0,120)]}),true);
 assert.ok(kinds(changed).has('became_silent'));
 const gaps=engine();for(let i=0;i<10;i++)gaps.add(report(i,{people:i<5?[person('missing')]:[],known:i<5}),i<5);assert.equal(kinds(gaps).has('missing_regular'),false);
});
test('focus excludes unrelated people, compares preceding categories and reports a return rather than a generic regular label',()=>{
 const e=engine('s6');for(let i=0;i<7;i++)e.add(report(i,{people:i===0||i===6?[person('returning',2,'0',0,120)]:[person('unrelated',2)],viewers:i===6?30:5,late:i===6?30:5}),true);
 const cards=collect(e);assert.ok(cards.some(c=>c.kind==='return_after_gap'));assert.ok(cards.some(c=>c.kind==='stream_audience'));assert.ok(cards.every(c=>c.personId!=='unrelated'));assert.equal(cards.some(c=>c.kind==='strong_hour'),false);
});
test('long streams flag repeated declines and concentrated chat with concrete denominators',()=>{
 const e=engine();for(let i=0;i<5;i++)e.add(report(i,{duration:180,viewers:10,late:2,people:[person('talkative',90),person('second',5),person('third',5)]}),true);
 assert.ok(kinds(e).has('late_decline'));assert.ok(kinds(e).has('chat_concentration'));
});
test('incomplete, live, YouTube and sparse observations do not manufacture attendance or silent patterns',()=>{
 for(const opts of [{known:false},{live:true},{source:'youtube'},{viewers:0}]){
  const e=engine();for(let i=0;i<3;i++){const r=report(i,{...opts,people:[person('quiet')]});r.streamComparison[0].viewers.youtube=r.streamComparison[0].viewers.all;r.streamComparison[0].viewers.twitch=r.streamComparison[0].viewers.all;e.add(r,false);}assert.deepEqual(collect(e),[]);
 }
 const e=engine();e.add({streamComparison:[]} as any,true);e.add(report(1,{duration:0}),true);assert.deepEqual(collect(e),[]);
 const blank=report(2,{people:[person('anonymous',0,'1000')]});blank.streamComparison[0].title='';blank.categories[0].id='';blank.audience[0].sources=['youtube'];blank.audience[0].intervals[0].kind='chat_proxy';blank.audience[0].observedMinutes=0;e.add(blank,true);assert.deepEqual(collect(e),[]);
});
test('source facts remain unchanged, owner exclusions and late corrections invalidate cached findings',()=>{
 const s=new StreamStore(':memory:');try{
  for(let i=0;i<5;i++){const at=base+i*day,id=s.startSession('owner',String(i),at,'platform',at);s.streamSample(id,at,'dota','Dota','Title',5);s.recordPoll(id,'owner',{startedAtMs:at,completedAtMs:at+59*minute,status:'complete',userIds:['quiet','owner'],userNames:{quiet:'Quiet'}});s.endSession(id,at+60*minute);}
  const db=(s as any).db,before=db.prepare('SELECT count(*) n FROM events').get(),opts={fromMs:base,toMs:base+6*day,includeInsights:true,summaryOnly:true,ownerId:'owner'};
  let r=s.analytics(opts);while(r.preparing)r=s.analytics(opts);
  assert.ok(r.insights?.some(c=>c.kind==='silent_regular'));assert.ok(!JSON.stringify(r.insights).includes('owner'));assert.deepEqual(db.prepare('SELECT count(*) n FROM events').get(),before);
  assert.deepEqual(s.analytics(opts).insights,r.insights);
  const quiet=String(s.persons().find(p=>p.display_name==='Quiet')!.id);s.renamePerson(quiet,'Renamed');let changed=s.analytics(opts);while(changed.preparing)changed=s.analytics(opts);assert.ok(JSON.stringify(changed.insights).includes('Renamed'));
  const all=s.insights(undefined,[],{ownerId:'owner'});assert.ok(all.preparing||all.insights?.length);assert.throws(()=>s.insights('missing'),/SESSION_NOT_FOUND/);
 }finally{s.close();}
});
test('category return cohorts have equal follow-up; immature cohorts never count as failures to return',()=>{
 const e=engine();for(let i=0;i<8;i++){
  const r=report(i,{category:i<4?'wow':'dota',people:i<2?Array.from({length:6},(_,n)=>person(`wow-${n}`,1,'0',0,120)):i===4?Array.from({length:6},(_,n)=>person(`dota-${n}`,1,'0',0,120)):[]});e.add(r,true);
  if(i===6)assert.equal(kinds(e).has('category_return'),false);
 }
 const c=collect(e).find(c=>c.kind==='category_return')!;assert.ok(c);assert.match(c.detail,/6 из 6/);assert.match(c.detail,/0 из 6/);assert.equal(c.sampleSize,12);
});
test('restart insight measures observed returns and a concentrated chat in the selected stream',()=>{
 const e=engine('s0'),r=report(0,{people:[person('a',90,'0',0,30),person('b',5,'0',0,30),person('c',5,'0',0,30)]});
 r.breaks=[{from:base+30*minute,to:base+35*minute}];for(const p of r.audience.slice(0,2))p.intervals.push({from:base+35*minute,to:base+60*minute,kind:'observed'});
 e.add(r,true,[{personId:'not-in-scope',at:base+60*minute},{personId:'a',at:base-60*minute}]);
 const c=collect(e).find(c=>c.kind==='restart_return')!;assert.ok(c);assert.match(c.detail,/2 из 3/);assert.ok(kinds(e).has('chat_concentration'));
});
test('anonymous money is part of the total but cannot masquerade as a dominant single supporter',()=>{
 const e=engine();for(let i=0;i<4;i++)e.add(report(i,{people:[person('anonymous',0,'1000'),person('named',0,'100'),person('other',0,'10')]}),true);
 assert.equal(kinds(e).has('support_concentration'),false);
});
test('donor windows cannot be inferred from coincident names or donation times outside the selected stream',()=>{
 const e=engine();for(let i=0;i<6;i++)e.add(report(i,{people:[person('one'),person('two')]}),true,[{personId:'one',at:base+i*7*day+60*minute},{personId:'two',at:base+i*7*day+60*minute}]);
 assert.equal(kinds(e).has('donor_window'),false);
 const out=engine();for(let i=0;i<6;i++)out.add(report(i),true,[{personId:'quiet',at:base-1},{personId:'supporter',at:base-1}]);assert.equal(kinds(out).has('donor_window'),false);
});
