import type Database from 'better-sqlite3';
import {assertTimestamp} from './domain.js';
export function registerDonationSum(db:Database.Database){
 db.aggregate('sum_donation_minor',{start:()=>0n,step:(sum:bigint,value:unknown)=>sum+BigInt(String(value)),result:(sum:bigint)=>sum.toString()});
}
export function donationWindow(from?:number,to?:number){
 if(from!==undefined)assertTimestamp(from);if(to!==undefined)assertTimestamp(to);
 if(from!==undefined&&to!==undefined&&to<=from)throw new Error('INVALID_DONATION_WINDOW');
 const clauses:string[]=[],args:number[]=[];if(from!==undefined&&from>0){clauses.push('e.occurred_at_ms>=?');args.push(from);}if(to!==undefined){clauses.push(from===undefined||from===0?'(e.occurred_at_ms<? OR e.occurred_at_ms IS NULL)':'e.occurred_at_ms<?');args.push(to);}return {sql:clauses.join(' AND ')||'1',args};
}
export function donationTiming(db:Database.Database,from:number,to:number,timezone:string){
 const window=donationWindow(from,to),clock=new Intl.DateTimeFormat('ru-RU',{timeZone:timezone,weekday:'short',hour:'2-digit',hourCycle:'h23'});
 const minutes=db.prepare(`SELECT cast(e.occurred_at_ms/60000 AS INTEGER)*60000 AS at,json_extract(e.payload_json,'$.currency') AS currency,sum_donation_minor(json_extract(e.payload_json,'$.amountMinor')) AS amount,count(*) AS n FROM effective_events e WHERE e.type='donation' AND ${window.sql} AND json_extract(e.payload_json,'$.amountMinor') IS NOT NULL AND json_extract(e.payload_json,'$.currency') IS NOT NULL GROUP BY at,currency`).all(...window.args) as {at:number|null;currency:string;amount:string;n:number}[];
 const cells=new Map<string,{day:string;hour:number;donationCount:number;donationTotals:Record<string,string>}>,totals:Record<string,string>={};let count=0,unknownCount=0;
 for(const row of minutes){count+=row.n;totals[row.currency]=(BigInt(totals[row.currency]??'0')+BigInt(row.amount)).toString();if(row.at===null){unknownCount+=row.n;continue;}
  const parts=clock.formatToParts(row.at),day=parts.find(p=>p.type==='weekday')!.value,hour=Number(parts.find(p=>p.type==='hour')!.value),key=`${day}:${hour}`,cell=cells.get(key)??{day,hour,donationCount:0,donationTotals:{}};
  cell.donationCount+=row.n;cell.donationTotals[row.currency]=(BigInt(cell.donationTotals[row.currency]??'0')+BigInt(row.amount)).toString();cells.set(key,cell);
 }
 return {count,unknownCount,totals,hours:[...cells.values()],basis:'Все донаты профиля с подтверждённым временем; донаты вне эфиров тоже учитываются.'};
}
export function donorRanking(db:Database.Database,sessionId:string|undefined,botJson:string,limit:number,from?:number,to?:number,currency='RUB'){
 if(!/^[A-Z]{3,8}$/.test(currency))throw new Error('INVALID_CURRENCY');const window=donationWindow(from,to);
 const groups=db.prepare(`SELECT p.id,p.display_name,p.revision,json_extract(e.payload_json,'$.currency') AS currency,sum_donation_minor(json_extract(e.payload_json,'$.amountMinor')) AS amount,count(*) AS n,
  (SELECT group_concat(DISTINCT source) FROM (SELECT source FROM identities WHERE person_id=p.id UNION SELECT 'youtube' FROM youtube_identities WHERE person_id=p.id)) AS sources
  FROM effective_events e JOIN identities i ON i.id=e.identity_id JOIN persons p ON p.id=i.person_id WHERE e.type='donation' AND (? IS NULL OR e.id IN(SELECT event_id FROM event_sessions WHERE session_id=?)) AND ${window.sql}
  AND NOT EXISTS(SELECT 1 FROM identities z WHERE z.person_id=p.id AND z.match_key IN(SELECT value FROM json_each(?)))
  AND json_extract(e.payload_json,'$.currency') IS NOT NULL AND json_extract(e.payload_json,'$.amountMinor') IS NOT NULL GROUP BY p.id,currency`).all(sessionId??null,sessionId??null,...window.args,botJson) as {id:string;display_name:string;revision:number;currency:string;amount:string;n:number;sources:string}[];
 const people=new Map<string,{id:string;display_name:string;revision:number;sources:string;messageCount:number;observedMinutes:number;donationCount:number;donationTotals:Record<string,string>}>();
 for(const g of groups){const row=people.get(g.id)??{id:g.id,display_name:g.display_name,revision:g.revision,sources:g.sources,messageCount:0,observedMinutes:0,donationCount:0,donationTotals:{}};row.donationCount+=g.n;row.donationTotals[g.currency]=g.amount;people.set(g.id,row);}
 return [...people.values()].sort((a,b)=>{const x=BigInt(a.donationTotals[currency]??'0'),y=BigInt(b.donationTotals[currency]??'0');return x===y?a.display_name.localeCompare(b.display_name):x>y?-1:1;}).slice(0,limit);
}