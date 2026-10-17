import type {audienceAnalytics} from './analytics.js';

export type InsightGroup='schedule'|'people'|'content'|'support'|'stream';
export interface InsightEvidence {sessionId:string;at:number;label:string}
export interface InsightCard {
 id:string;kind:string;group:InsightGroup;title:string;detail:string;basis:string;action:string;
 score:number;personId?:string;personName?:string;sampleSize:number;evidence:InsightEvidence[];
}
type Report=ReturnType<typeof audienceAnalytics>;
interface Visit {sessionId:string;at:number;label:string;observed:number;messages:number;donated:boolean}
interface Count {donorVisits?:number;visits:number;evidence:InsightEvidence[]}
export interface InsightPerson {
 id:string;name:string;sources:string[];firstIndex:number;firstCategory:string;returned:boolean;visits:number;observed:number;messages:number;silent:number;donorVisits:number;
 slots:Record<string,Count>;categories:Record<string,Count>;recent:Visit[];money:Record<string,string>;
}
interface PeopleMap {get(id:string):InsightPerson|undefined;set(id:string,value:InsightPerson):void;values():Iterable<InsightPerson>}
interface Slot {key:string;label:string;visits:number;known:number;viewerSum:number;viewerMinutes:number;minutes:number;donorVisits:number;donors:string[];dates:string[];evidence:InsightEvidence[]}
interface Category {name:string;visits:number;known:number;minutes:number;messages:number;viewerSum:number;viewerMinutes:number;evidence:InsightEvidence[]}
interface Stream {id:string;at:number;end:number;day:string;title:string;known:boolean;messages:number;chatters:number;topMessages:number;mean:number|null;early:number|null;late:number|null;duration:number;categories:string[];closed:boolean;slots:string[];restarts:{before:number;returned:number;at:number}[]}
const pct=(a:number,b:number)=>Math.round(a/b*100);
const decimal=(n:number)=>n.toLocaleString('ru-RU',{maximumFractionDigits:1});
const evidence=(s:Stream):InsightEvidence=>({sessionId:s.id,at:s.at,label:s.title});
function append<T>(a:T[],b:T,limit=8){if(a.length<limit)a.push(b);}
function hit(target:Record<string,Count>,key:string,e:InsightEvidence){const c=target[key]??{visits:0,evidence:[]};c.visits++;append(c.evidence,e);target[key]=c;}
/** Only already-computed stream reports are consumed. Per-person state is held in the
 * existing file-backed workspace. Donation timestamps use one indexed stream query.
 * No new permanent facts are written. */
export class InsightAccumulator {
 private slots=new Map<string,Slot>();
 private categories=new Map<string,Category>();
 private streams:Stream[]=[];
 private clock:Intl.DateTimeFormat;
 private clocks=new Map<number,{day:string;hour:number;date:string}>();
 constructor(private people:PeopleMap,readonly timezone='Europe/Moscow',private focus=''){
  this.clock=new Intl.DateTimeFormat('ru-RU',{timeZone:timezone,weekday:'short',hour:'2-digit',year:'numeric',month:'2-digit',day:'2-digit',hourCycle:'h23'});
 }
 private local(at:number){const key=Math.floor(at/60000),cached=this.clocks.get(key);if(cached)return cached;const p=Object.fromEntries(this.clock.formatToParts(at).map(p=>[p.type,p.value]));const value={day:p.weekday!,hour:Number(p.hour),date:`${p.year}-${p.month}-${p.day}`};this.clocks.set(key,value);return value;}
 add(report:Report,chatComplete:boolean,tips:{personId:string;at:number}[]=[]){
  this.clocks.clear();
  const stream=report.streamComparison[0];if(!stream||!stream.durationMs)return;
  const windows=report.activityWindows;
  const viewerMetric=stream.viewers[report.filters.source==='all'?'all':report.filters.source];
  const duration=stream.durationMs/60000,knownMinutes=report.timeline.filter(p=>p.presenceKnown&&!p.isBreak).length;
  const known=report.filters.source!=='youtube'&&knownMinutes/duration>=.8;
  const timeline=report.timeline.filter(p=>!p.isBreak&&p.viewers!=null&&!p.viewersPartial);
  const edge=(from:number,to:number)=>{const points=timeline.filter(p=>p.at>=from&&p.at<to);return points.length>=20?points.reduce((n,p)=>n+p.viewers!,0)/points.length:null;};
  const s:Stream={id:stream.id,at:stream.startedAt,end:stream.endedAt,day:this.local(stream.startedAt).day,title:stream.title||'Эфир',known:known&&chatComplete,messages:stream.messages,chatters:report.audience.filter(p=>p.messages>0).length,topMessages:Math.max(0,...report.audience.map(p=>p.messages)),mean:viewerMetric.coverageRatio!=null&&viewerMetric.coverageRatio>=.8?viewerMetric.mean:null,early:edge(stream.startedAt,stream.startedAt+30*60000),late:edge(stream.endedAt-30*60000,stream.endedAt),duration,categories:report.categories.filter(c=>c.id&&c.minutes>=15).map(c=>c.id),closed:report.sessions.every(session=>session.ended_at_ms!==null),slots:[],restarts:[]};
  // Current broadcasts can supply a focus comparison but never prove recurring absences.
  const closed=s.closed;
  this.streams.push(s);
  const beforePause=(at:number)=>report.audience.filter(p=>p.intervals.some(i=>i.kind==='observed'&&i.from<at&&i.to>at-5*60000));
  if(s.known)for(const pause of report.breaks??[]){const before=beforePause(pause.from),returned=before.filter(p=>p.intervals.some(i=>i.kind==='observed'&&i.from<pause.to+15*60000&&i.to>pause.to));if(before.length>=3&&s.end>=pause.to+15*60000)s.restarts.push({before:before.length,returned:returned.length,at:pause.to});}
  const donorSlots=new Map<string,Set<string>>();
  for(const tip of tips){if(!report.audience.some(p=>p.id===tip.personId)||!windows.some(w=>tip.at>=w.from&&tip.at<w.to))continue;const local=this.local(tip.at),key=`${local.day}:${local.hour}`,ids=donorSlots.get(key)??new Set<string>();ids.add(tip.personId);donorSlots.set(key,ids);}
  const e=evidence(s),eligible=new Map<string,number>();
  for(const w of windows)for(let at=w.from;at<w.to;){const end=Math.min(w.to,(Math.floor(at/3600000)+1)*3600000),local=this.local(at),key=`${local.day}:${local.hour}`;eligible.set(key,(eligible.get(key)??0)+(end-at)/60000);at=end;}
  const slotKeys=[...eligible].filter(([,minutes])=>minutes>=15).map(([key])=>key);
  s.slots=slotKeys;const knownSlots=new Set<string>();
  for(const key of slotKeys){
   const [day,hour]=key.split(':'),h=Number(hour),minutes=eligible.get(key)!;
   const row=this.slots.get(key)??{key,label:`${day} ${String(h).padStart(2,'0')}:00–${String((h+1)%24).padStart(2,'0')}:00`,visits:0,known:0,viewerSum:0,viewerMinutes:0,minutes:0,donorVisits:0,donors:[],dates:[],evidence:[]};
   if(closed){row.visits++;row.known+=Number(s.known&&report.timeline.filter(p=>{const l=this.local(p.at);return p.presenceKnown&&`${l.day}:${l.hour}`===key;}).length/minutes>=.8);row.minutes+=minutes;append(row.evidence,e);const date=this.local(s.at).date;if(!row.dates.includes(date))append(row.dates,date,4);}
   // Use only full combined-platform samples, never sums with a missing platform.
   const points=timeline.filter(p=>{const l=this.local(p.at);return `${l.day}:${l.hour}`===key;});
   if(closed&&points.length/minutes>=.8){row.viewerSum+=points.reduce((n,p)=>n+p.viewers!,0);row.viewerMinutes+=points.length;}
   if(closed&&donorSlots.has(key)){row.donorVisits++;for(const person of donorSlots.get(key)!)if(!row.donors.includes(person))row.donors.push(person);}
   if(s.known&&report.timeline.filter(p=>{const l=this.local(p.at);return p.presenceKnown&&`${l.day}:${l.hour}`===key;}).length/minutes>=.8)knownSlots.add(key);
   this.slots.set(key,row);
  }
  for(const c of report.categories){if(!c.id||c.minutes<15)continue;const row=this.categories.get(c.id)??{name:c.name,visits:0,known:0,minutes:0,messages:0,viewerSum:0,viewerMinutes:0,evidence:[]};if(closed){row.visits++;row.known+=Number(s.known);row.minutes+=c.minutes;row.messages+=chatComplete?c.messages:0;append(row.evidence,e);const points=timeline.filter(p=>windows.some(w=>w.categoryId===c.id&&p.at>=w.from&&p.at<w.to));if(points.length/c.minutes>=.8){row.viewerSum+=points.reduce((n,p)=>n+p.viewers!,0);row.viewerMinutes+=points.length;}}this.categories.set(c.id,row);}
  for(const p of report.audience){
   const present=p.observedMinutes>=5||p.messages>0,donated=Object.values(p.donations).some(n=>BigInt(n)>0n);
   if(!present&&!donated)continue;
   const row=this.people.get(p.id)??{id:p.id,name:p.name,sources:p.sources,firstIndex:-1,firstCategory:'',returned:false,visits:0,observed:0,messages:0,silent:0,donorVisits:0,slots:{},categories:{},recent:[],money:{}};
   row.name=p.name;row.sources=[...new Set([...row.sources,...p.sources])];
   if(closed&&present){if(row.firstIndex<0){row.firstIndex=this.streams.length-1;const at=Math.min(...p.intervals.map(i=>i.from),...p.messageMinutes.map(m=>m.at));row.firstCategory=windows.find(w=>at>=w.from&&at<w.to)?.categoryId??'';}else if(this.streams.length-1-row.firstIndex<=3)row.returned=true;}
   if(closed){row.visits+=Number(present);row.observed+=p.observedMinutes;row.messages+=p.messages;row.donorVisits+=Number(donated);row.silent+=Number(p.observedMinutes>=30&&p.messages===0&&s.known);for(const [currency,n]of Object.entries(p.donations))row.money[currency]=(BigInt(row.money[currency]??'0')+BigInt(n)).toString();}
   if(closed&&s.known){
    for(const key of knownSlots){let minutes=0;for(const span of p.intervals){if(span.kind!=='observed')continue;for(let at=span.from;at<span.to;){const end=Math.min(span.to,(Math.floor(at/3600000)+1)*3600000),l=this.local(at);if(`${l.day}:${l.hour}`===key)minutes+=(end-at)/60000;at=end;}}
     const wrote=p.messageMinutes.some(m=>{const l=this.local(m.at);return `${l.day}:${l.hour}`===key;});
     if(minutes>=15||wrote){hit(row.slots,key,e);if(donorSlots.get(key)?.has(p.id))row.slots[key]!.donorVisits=(row.slots[key]!.donorVisits??0)+1;}
    }
    for(const key of s.categories){const spans=windows.filter(w=>w.categoryId===key);const minutes=p.intervals.filter(i=>i.kind==='observed').reduce((n,i)=>n+spans.reduce((m,w)=>m+Math.max(0,Math.min(i.to,w.to)-Math.max(i.from,w.from))/60000,0),0);if(minutes>=5||p.messageMinutes.some(m=>spans.some(w=>m.at>=w.from&&m.at<w.to)))hit(row.categories,key,e);}
   }
   row.recent.push({sessionId:s.id,at:s.at,label:s.title,observed:p.observedMinutes,messages:p.messages,donated});row.recent=row.recent.slice(-12);this.people.set(p.id,row);
  }
 }
 *find():Generator<InsightCard|undefined>{
  const focus=this.streams.find(s=>s.id===this.focus),closed=this.streams.filter(s=>s.closed);
  const card=(kind:string,group:InsightGroup,title:string,detail:string,basis:string,action:string,score:number,sampleSize:number,proof:InsightEvidence[],personId?:string):InsightCard=>({id:JSON.stringify([kind,personId,title,detail,proof[0]?.sessionId]),kind,group,title,detail,basis,action,score,sampleSize,evidence:proof,...(personId?{personId,personName:this.people.get(personId)!.name}:{})});
  const cohorts=new Map<string,{total:number;returned:number;evidence:InsightEvidence[]}>();
  const money=new Map<string,{total:bigint;top:bigint;person:InsightPerson;supporters:number}>();
  const qualified=closed.filter(s=>s.known),qualifiedIds=new Set(qualified.map(s=>s.id)),recent=qualified.slice(-5),earlier=qualified.filter(s=>!recent.includes(s)).slice(-7);
  for(const p of this.people.values()){
   for(const [currency,n]of Object.entries(p.money)){const amount=BigInt(n);if(amount<=0n)continue;const row=money.get(currency)??{total:0n,top:0n,person:p,supporters:0};row.total+=amount;row.supporters+=Number(!/^(аноним|anonymous|anon)$/i.test(p.name));if(!/^(аноним|anonymous|anon)$/i.test(p.name)&&amount>row.top){row.top=amount;row.person=p;}money.set(currency,row);}
   if(p.firstIndex>=0&&p.firstCategory&&this.streams.length-1-p.firstIndex>=3&&this.streams.slice(p.firstIndex+1,p.firstIndex+4).every(s=>s.closed&&s.known)){
    const cohort=cohorts.get(p.firstCategory)??{total:0,returned:0,evidence:[]};cohort.total++;cohort.returned+=Number(p.returned);const first=this.streams[p.firstIndex]!;if(!cohort.evidence.some(e=>e.sessionId===first.id))append(cohort.evidence,evidence(first));cohorts.set(p.firstCategory,cohort);
   }
   const relevant=!focus||p.recent.some(v=>v.sessionId===focus.id),proof=p.recent.map(v=>({sessionId:v.sessionId,at:v.at,label:v.label}));
   if(relevant&&p.silent>=4&&p.observed>=120&&p.messages<=Math.max(2,p.visits*.2))yield card('silent_regular',p.donorVisits>=2?'support':'people',p.donorVisits>=2?'Молчаливый участник поддерживает канал':'Постоянное присутствие без сообщений',`${p.name}: ${p.silent} эфиров с присутствием от 30 минут без сообщений; всего ${p.messages} сообщений.${p.donorVisits>=2?` Донаты на ${p.donorVisits} эфирах.`:''}`,'Полные опросы Twitch и история сообщений. Присутствие в чате не доказывает просмотр видео.','Учитывай этого участника при оценке ядра, даже если он почти не пишет.',70+p.donorVisits,p.visits,proof,p.id);
   for(const [key,c]of Object.entries(p.slots)){
    const slot=this.slots.get(key)!;if(!relevant||c.visits<4||slot.known<5||c.visits/slot.known<.8||slot.dates.length<3)continue;
    const otherKnown=[...this.slots.values()].filter(x=>x.key!==key).reduce((n,x)=>n+x.known,0),otherVisits=Object.entries(p.slots).filter(([k])=>k!==key).reduce((n,[,v])=>n+v.visits,0);
    if(otherKnown<5||otherVisits/otherKnown>=c.visits/slot.known-.3)continue;
    yield card('person_schedule',p.donorVisits>=2?'support':'schedule',`${p.name} · привычное время`,`${slot.label}: присутствие на ${c.visits} из ${slot.known} эфиров с полными данными.${p.donorVisits>=2?` Донатил именно в этом окне на ${c.donorVisits??0} эфирах; всего поддерживал ${p.donorVisits} эфиров за период.`:''}`,`В других часовых окнах — ${otherVisits} из ${otherKnown} наблюдений. Сравниваются только часы, когда шёл эфир; один эфир может попадать в несколько окон.`,'Учитывай это время при планировании. Донаты в будущем не гарантированы.',80+p.donorVisits,c.visits,c.evidence,p.id);
   }
   for(const [key,c]of Object.entries(p.categories)){
    const category=this.categories.get(key)!;const others=[...this.categories].filter(([k])=>k!==key),eligible=others.reduce((n,[,x])=>n+x.known,0),visits=Object.entries(p.categories).filter(([k])=>k!==key).reduce((n,[,x])=>n+x.visits,0);
    if(relevant&&category.known>=5&&c.visits>=4&&c.visits/category.known>=.8&&eligible>=5&&visits/eligible<=.3)yield card('person_category','content',`${p.name} чаще приходит на ${category.name}`,`Присутствовал на ${c.visits} из ${category.known} эфиров этой категории; в других категориях — ${visits} из ${eligible} наблюдений.`,'Учитываются отрезки категории от 15 минут и эфиры с полными данными Twitch. Смешанный эфир может входить в обе группы.','При смене игры учитывай, что часть аудитории приходит ради конкретного контента.',75,c.visits,c.evidence,p.id);
   }
   const last=p.recent.at(-1),hits=earlier.filter(s=>p.recent.some(v=>v.sessionId===s.id&&v.observed>=5));
   if(!focus&&last&&recent.length===5&&earlier.length>=5&&hits.length>=4&&hits.length/earlier.length>=.6&&recent.filter(s=>s.slots.some(key=>(p.slots[key]?.visits??0)>=4)).length>=3&&!recent.some(s=>p.recent.some(v=>v.sessionId===s.id)))yield card('missing_regular','people',`${p.name} перестал появляться`,`${hits.length} посещений из ${earlier.length} предыдущих наблюдаемых эфиров, затем пропущены последние пять.`, 'Пять завершённых эфиров с полными данными Twitch. Это отсутствие в чате, а не доказанный уход с канала.','Открой историю участника и проверь, не изменились ли расписание или категория.',85,recent.length,recent.map(evidence),p.id);
   const visits=p.recent.filter(v=>qualifiedIds.has(v.sessionId)),before=visits.slice(-6,-3),after=visits.slice(-3);
   if(relevant&&before.length===3&&after.length===3&&before.every(v=>v.messages>=5)&&after.every(v=>v.observed>=15&&v.messages===0))yield card('became_silent','people',`${p.name} стал участвовать молча`,'На трёх предыдущих посещениях писал не менее пяти сообщений; на последних трёх присутствовал от 15 минут без сообщений.','Шесть посещённых эфиров с полными опросами и без известных разрывов сбора.','Человек продолжает присутствовать: снижение сообщений не равно потере участника.',80,6,visits.slice(-6).map(v=>({sessionId:v.sessionId,at:v.at,label:v.label})),p.id);
   if(focus){const current=p.recent.find(v=>v.sessionId===focus.id),prior=p.recent.filter(v=>v.at<focus.at).at(-1);if(current&&prior&&focus.at-prior.at>=14*86400000)yield card('return_after_gap','people',`${p.name} вернулся после перерыва`,`Предыдущее известное участие было ${Math.floor((focus.at-prior.at)/86400000)} дней назад.`,'Сообщения или наблюдения Twitch в пределах истории сравнения.','Возвращение давнего участника может быть незаметно в общих счётчиках.',65,2,[{sessionId:prior.sessionId,at:prior.at,label:prior.label},evidence(focus)],p.id);}
   yield undefined; // Let the report worker yield even when no pattern matches.
  }
  if(!focus)for(const [currency,m]of money){
   if(m.supporters>=2&&m.top*100n>=m.total*60n)yield card('support_concentration','support',`${m.person.name} обеспечивает основную поддержку`,`${Number(m.top*100n/m.total)}% суммы донатов в ${currency} приходится на одного человека. Всего известных участников поддержки: ${m.supporters}.`, 'Валюты считаются отдельно. Анонимные суммы включены в итог, но не приписаны одному человеку.','Учитывай зависимость дохода от одного участника при оценке роста канала.',85,m.supporters,m.person.recent.filter(v=>v.donated).map(v=>({sessionId:v.sessionId,at:v.at,label:v.label})),m.person.id);
  }
  const mature=[...cohorts].filter(([,c])=>c.total>=5).sort((a,b)=>b[1].returned/b[1].total-a[1].returned/a[1].total),bestC=mature[0],worstC=mature.at(-1);
  if(!focus&&bestC&&worstC&&bestC!==worstC&&bestC[1].returned/bestC[1].total-worstC[1].returned/worstC[1].total>=.3)yield card('category_return','content',`${this.categories.get(bestC[0])!.name} чаще приводит возвращающихся участников`,`${bestC[1].returned} из ${bestC[1].total} впервые замеченных в периоде участников вернулись в течение следующих трёх эфиров; в ${this.categories.get(worstC[0])!.name} — ${worstC[1].returned} из ${worstC[1].total}.`,'Это первое наблюдение в выбранном периоде, а не доказанный первый визит на канал. У всех были три следующих эфира с полными данными Twitch.','Оценивай не только размер аудитории категории, но и последующие возвращения.',90,bestC[1].total+worstC[1].total,[...bestC[1].evidence,...worstC[1].evidence]);
  const reliable=[...this.slots.values()].filter(s=>s.visits>=4&&s.dates.length>=3&&s.viewerMinutes>=s.minutes*.8);
  for(const slot of reliable){
   const day=slot.key.split(':')[0],others=reliable.filter(s=>s!==slot&&s.key.split(':')[0]===day),baselineMinutes=others.reduce((n,s)=>n+s.viewerMinutes,0),baseline=baselineMinutes?others.reduce((n,s)=>n+s.viewerSum,0)/baselineMinutes:0,mean=slot.viewerSum/slot.viewerMinutes;
   if(!focus&&baseline>0&&mean>=baseline*1.3&&mean-baseline>=2){const starts=this.streams.filter(s=>s.day===day),missed=starts.filter(s=>{const end=this.local(s.end-1);return s.closed&&!s.slots.includes(slot.key)&&end.day===day&&end.date===this.local(s.at).date&&end.hour<Number(slot.key.split(':')[1]);});yield card('strong_hour','schedule',`${slot.label} · аудитория выше`,`${decimal(mean)} зрителя в среднем против ${decimal(baseline)} в других изученных часах этого дня.${missed.length?` ${missed.length} эфиров этого дня закончились раньше этого окна.`:''}`,`${slot.visits} эфиров; ${Math.round(slot.viewerMinutes)} минут замеров. Категория и длительность эфира могут влиять на разницу.`,'Стоит проверить это окно в нескольких сопоставимых эфирах. Неизученные часы не оцениваются.',90,slot.visits,slot.evidence);}
   if(!focus&&slot.donorVisits>=3&&slot.donors.length>=2)yield card('donor_window','support',`${slot.label} · окно поддержки`,`Донаты на ${slot.donorVisits} из ${slot.visits} эфиров в этом окне; в этом окне поддержали ${slot.donors.length} разных участников.`,'Подтверждённое время донатов и установленные связи аккаунтов. Сумма не используется для выбора окна: один крупный донат не создаёт закономерность.','Учитывай окно поддержки вместе с числом зрителей и своим расписанием.',85,slot.visits,slot.evidence);
  }
  const categories=[...this.categories.values()].filter(c=>c.visits>=4&&c.viewerMinutes/c.minutes>=.8).sort((a,b)=>b.viewerSum/b.viewerMinutes-a.viewerSum/a.viewerMinutes);
  const best=categories[0],worst=categories.at(-1);
  if(!focus&&best&&worst&&best!==worst&&best.viewerSum/best.viewerMinutes>=Math.max(2,worst.viewerSum/worst.viewerMinutes)*1.3)yield card('category_audience','content',`${best.name} собирает больше зрителей`,`${decimal(best.viewerSum/best.viewerMinutes)} зрителя в среднем против ${decimal(worst.viewerSum/worst.viewerMinutes)} в ${worst.name}.`,`${best.visits} и ${worst.visits} эфиров. Это связь с категорией; время и состав аудитории могут различаться.`,'Сравни категории в одинаковые часы, прежде чем менять контент.',80,best.visits+worst.visits,[...best.evidence,...worst.evidence]);
  const falling=closed.filter(s=>s.duration>=120&&s.early!==null&&s.early>=3&&s.late!==null&&s.late<=s.early*.6),long=closed.filter(s=>s.duration>=120&&s.early!==null&&s.late!==null);
  if(!focus&&long.length>=5&&falling.length/long.length>=.8)yield card('late_decline','schedule','Длинные эфиры часто заканчиваются со спадом',`На ${falling.length} из ${long.length} длинных эфиров аудитория в последние 30 минут была минимум на 40% ниже первых 30 минут.`,'Эфиры от двух часов; минимум 20 полных замеров в каждом сравниваемом отрезке.','Проверь более короткий формат. По этим данным нельзя отделить усталость аудитории от времени суток.',85,long.length,falling.map(evidence).slice(0,8));
  const concentrated=closed.filter(s=>s.messages>=30&&s.chatters>=3&&s.topMessages/s.messages>=.7);
  if(!focus&&concentrated.length>=3)yield card('chat_concentration','stream','Активность чата часто держится на одном участнике',`На ${concentrated.length} из ${closed.length} завершённых эфиров один человек написал не менее 70% сообщений.`, 'Каждый отмеченный эфир: от 30 сообщений и минимум три автора.','Оценивай вместе число пишущих людей и сообщения, чтобы не принять активность одного за рост всего чата.',70,concentrated.length,concentrated.slice(-8).map(evidence));
  const candidates=focus?[focus]:closed;
  for(const s of candidates){
   if(focus)for(const pause of s.restarts)yield card('restart_return','stream','Участники после перезапуска',`После перерыва снова замечены ${pause.returned} из ${pause.before} участников, присутствовавших в последние пять минут перед ним.`,'Сравниваются наблюдения Twitch до перерыва и в первые 15 минут после возобновления; это не список видеозрителей.','Так можно оценить последствия обрыва поимённо, а не только по общему счётчику.',85,pause.before,[{...evidence(s),at:pause.at}]);

   if(focus&&s.messages>=30&&s.chatters>=3&&s.topMessages/s.messages>=.7)yield card('chat_concentration','stream','Активность чата держится на одном участнике',`${pct(s.topMessages,s.messages)}% сообщений написал один человек; всего писали ${s.chatters} участников.`,`${s.messages} сообщений в эфире. Число сообщений и широта участия — разные показатели.`,'Оценивай вместе количество пишущих людей и сообщения, чтобы не принять активность одного за рост всего чата.',70,s.chatters,[evidence(s)]);
   if(focus&&s.mean!==null){const prior=closed.filter(x=>x.id!==focus.id&&x.at<focus.at&&x.mean!==null&&x.categories.some(c=>focus.categories.includes(c)));if(prior.length>=5){const means=prior.map(s=>s.mean!).sort((a,b)=>a-b),median=means[Math.floor(means.length/2)]!;if(median>=2&&(s.mean>=median*1.3||s.mean<=median*.7))yield card('stream_audience','stream','Аудитория заметно отличается от привычной',`В среднем ${decimal(s.mean)} зрителя; медиана предыдущих эфиров с общей категорией — ${decimal(median)}.`,`${prior.length} предыдущих эфиров; полнота замеров не ниже 80%. Расписание и длительность могут различаться.`,'Посмотри график и состав участников, чтобы понять, где возникла разница.',90,prior.length,[evidence(s),...prior.slice(-5).map(evidence)]);}}
  }
 }
}
