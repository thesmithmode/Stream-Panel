import {currencyRates} from './rates.js';
export interface TimeCell {day:string;hour:number;observed:number;estimated:number;messages:number;sampleMinutes:number;observedKnownMinutes:number;viewersTotal:number;viewerSamples:number;donationTotals:Record<string,string>;donationCount:number}
const empty=():TimeCell=>({day:'',hour:0,observed:0,estimated:0,messages:0,sampleMinutes:0,observedKnownMinutes:0,viewersTotal:0,viewerSamples:0,donationTotals:{},donationCount:0});
/** Pool numerators and exposure before dividing; empty time slots stay absent. */
export function timePatterns(cells:TimeCell[]){
 const days=new Map<string,TimeCell>(),hours=new Map<number,TimeCell>();
 for(const cell of cells)for(const target of [days,hours]){
  const key=target===days?cell.day:cell.hour;
  const map=target as Map<string|number,TimeCell>,row=map.get(key)??{...empty(),day:cell.day,hour:cell.hour};
  for(const field of ['observed','estimated','messages','sampleMinutes','observedKnownMinutes','viewersTotal','viewerSamples','donationCount'] as const)row[field]+=cell[field];
  for(const [currency,amount] of Object.entries(cell.donationTotals))row.donationTotals[currency]=(BigInt(row.donationTotals[currency]??'0')+BigInt(amount)).toString();
  map.set(key,row);
 }
 const result=(row:TimeCell)=>({...row,viewerMean:row.viewerSamples?row.viewersTotal/row.viewerSamples:null,observedMean:row.observedKnownMinutes?row.observed/row.observedKnownMinutes:null,estimatedMean:row.sampleMinutes?row.estimated/row.sampleMinutes:null,messagesPerHour:row.sampleMinutes?row.messages*60/row.sampleMinutes:null,donationsPerHour:row.sampleMinutes?row.donationCount*60/row.sampleMinutes:null,donationsPerHourMinor:currencyRates(row.donationTotals,Math.round(row.sampleMinutes*60000))});
 return {byHour:[...hours.values()].sort((a,b)=>a.hour-b.hour).map(result),byWeekday:[...days.values()].sort((a,b)=>['пн','вт','ср','чт','пт','сб','вс'].indexOf(a.day)-['пн','вт','ср','чт','пт','сб','вс'].indexOf(b.day)).map(result)};
}
