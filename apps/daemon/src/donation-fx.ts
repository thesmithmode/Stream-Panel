import type {CbrRate} from '../../../packages/core/src/donation-fx.js';
import type {StorePort} from './store-contract.js';

const isoDate=(value:string)=>{const parts=/^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);return parts?`${parts[3]}-${parts[2]}-${parts[1]}`:'';};
/** CBR returns the rate in force on the requested day, including weekends/holidays. */
export function parseCbrRates(xml:string,day:string){
 const effectiveDay=isoDate(/<ValCurs\b[^>]*\bDate="([^"]+)"/.exec(xml)?.[1]??'');
 if(!effectiveDay||effectiveDay>day||!xml.includes('</ValCurs>'))throw new Error('INVALID_CBR_RESPONSE');
 const rates:CbrRate[]=[];
 for(const match of xml.matchAll(/<Valute\b[^>]*>([\s\S]*?)<\/Valute>/g)){
  const body=match[1]!,currency=/<CharCode>([A-Z]{3})<\/CharCode>/.exec(body)?.[1],nominal=Number(/<Nominal>(\d+)<\/Nominal>/.exec(body)?.[1]),value=/<Value>(\d+,\d{4})<\/Value>/.exec(body)?.[1]?.replace(',','.');
  if(!currency||!value||!Number.isSafeInteger(nominal)||nominal<=0)throw new Error('INVALID_CBR_RESPONSE');
  rates.push({currency,value,nominal});
 }
 if(!rates.length)throw new Error('INVALID_CBR_RESPONSE');
 return {effectiveDay,rates};
}
export async function fetchCbrRates(day:string,request:typeof fetch=fetch){
 const [year,month,date]=day.split('-');
 const response=await request(`https://www.cbr.ru/scripts/XML_daily.asp?date_req=${date}/${month}/${year}`,{signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw new Error('CBR_UNAVAILABLE');
 const xml=await response.text();
 if(xml.length>256000)throw new Error('INVALID_CBR_RESPONSE');
 return parseCbrRates(xml,day);
}
type Runtime={db:StorePort<'pendingExchangeDates'|'saveExchangeRates'>};
/** Bounded history backfill and new tips share the same persisted daily rates. */
export function startDonationFx(runtimes:()=>Iterable<Runtime>,enabled:()=>boolean,onError:()=>void,load=fetchCbrRates){
 let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
 const run=async()=>{
  if(enabled())for(const runtime of runtimes()){
   if(stopped)break;
   try{
    const days=await runtime.db.call('pendingExchangeDates',Date.now());
    for(const day of days){
     if(stopped)break;
     const {effectiveDay,rates}=await load(day);
     if(stopped)break;
     await runtime.db.call('saveExchangeRates',day,effectiveDay,rates,Date.now());
    }
   }catch{onError();}
  }
  if(!stopped)timer=setTimeout(()=>void run(),60000);
 };
 void run();
 return ()=>{stopped=true;clearTimeout(timer);};
}
