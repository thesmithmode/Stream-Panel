import type Database from 'better-sqlite3';

export type CbrRate={currency:string;value:string;nominal:number};
export const donationFxSchema=`
CREATE TABLE IF NOT EXISTS cbr_days(day TEXT PRIMARY KEY,effective_day TEXT NOT NULL,retry_at_ms INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS cbr_rates(day TEXT NOT NULL,currency TEXT NOT NULL,value TEXT NOT NULL,nominal INTEGER NOT NULL,effective_day TEXT NOT NULL,PRIMARY KEY(day,currency)) WITHOUT ROWID;
CREATE VIEW IF NOT EXISTS valued_events AS SELECT e.*,CASE WHEN json_extract(e.payload_json,'$.currency')='RUB' THEN json_extract(e.payload_json,'$.amountMinor')
 ELSE donation_rub_minor(json_extract(e.payload_json,'$.amountMinor'),r.value,r.nominal) END AS rub_amount_minor,r.effective_day AS exchange_rate_date
 FROM effective_events e LEFT JOIN cbr_rates r ON e.type='donation' AND r.currency=json_extract(e.payload_json,'$.currency') AND r.day=date(e.occurred_at_ms/1000,'unixepoch','+3 hours');
-- Cached monetary facts from older versions contain separate currency totals.
DELETE FROM analytics_reports;
DELETE FROM analytics_money_facts;
DELETE FROM analytics_stream_cache;
UPDATE analytics_fact_versions SET money=money+1;
UPDATE analytics_stream_revisions SET revision=revision+1;
UPDATE analytics_global_revision SET revision=revision+1;
UPDATE ui_revisions SET revision=revision+1;
PRAGMA user_version=31;
`;

/** Amounts use the ledger's hundredths convention. Round once per tip. */
export function rubMinor(amount:unknown,value:unknown,nominal:unknown):string|null {
 if(typeof amount!=='string'||!/^\d+$/.test(amount)||typeof value!=='string'||!/^\d+\.\d{4}$/.test(value)||typeof nominal!=='number'||!Number.isSafeInteger(nominal)||nominal<=0)return null;
 const numerator=BigInt(value.replace('.','')),denominator=BigInt(nominal)*10000n;
 if(numerator<=0n)return null;
 return ((BigInt(amount)*numerator+denominator/2n)/denominator).toString();
}
export function registerDonationFx(db:Database.Database){db.function('donation_rub_minor',{deterministic:true},rubMinor);}

export function donationValuation(db:Database.Database,payload:Record<string,unknown>,at:number|null){
 if(payload.currency==='RUB')return {rubAmountMinor:typeof payload.amountMinor==='string'?payload.amountMinor:null,exchangeRateDate:null};
 const rate=db.prepare("SELECT value,nominal,effective_day FROM cbr_rates WHERE day=date(?/1000,'unixepoch','+3 hours') AND currency=?").get(at,String(payload.currency)) as {value:string;nominal:number;effective_day:string}|undefined;
 return {rubAmountMinor:rubMinor(payload.amountMinor,rate?.value,rate?.nominal),exchangeRateDate:rate?.effective_day??null};
}

export class DonationFx {
 constructor(private db:Database.Database){}
 pendingDates(now:number):string[]{
  return (this.db.prepare(`SELECT DISTINCT date(e.occurred_at_ms/1000,'unixepoch','+3 hours') day FROM effective_events e
   LEFT JOIN cbr_days d ON d.day=date(e.occurred_at_ms/1000,'unixepoch','+3 hours')
   LEFT JOIN cbr_rates r ON r.day=d.day AND r.currency=json_extract(e.payload_json,'$.currency')
   WHERE e.type='donation' AND e.occurred_at_ms IS NOT NULL AND json_extract(e.payload_json,'$.currency')<>'RUB'
   AND r.day IS NULL AND (d.day IS NULL OR d.retry_at_ms<=?) ORDER BY day DESC LIMIT 10`).all(now) as {day:string}[]).map(r=>r.day);
 }
 save(day:string,effectiveDay:string,rates:CbrRate[],now:number):void{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDay)||effectiveDay>day||rates.length===0||rates.some(r=>!/^[A-Z]{3}$/.test(r.currency)||rubMinor('100',r.value,r.nominal)===null))throw new Error('INVALID_CBR_RATES');
  this.db.transaction(()=>{
   const insert=this.db.prepare('INSERT OR IGNORE INTO cbr_rates VALUES(?,?,?,?,?)');let changes=0;
   for(const rate of rates)changes+=insert.run(day,rate.currency,rate.value,rate.nominal,effectiveDay).changes;
   this.db.prepare('INSERT INTO cbr_days VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET effective_day=excluded.effective_day,retry_at_ms=excluded.retry_at_ms').run(day,effectiveDay,now+86400000);
   if(changes){
    this.db.exec('DELETE FROM analytics_reports; DELETE FROM analytics_money_facts; DELETE FROM analytics_stream_cache; UPDATE analytics_fact_versions SET money=money+1; UPDATE analytics_stream_revisions SET revision=revision+1; UPDATE analytics_global_revision SET revision=revision+1; UPDATE ui_revisions SET revision=revision+1;');
   }
  }).immediate();
 }
 pendingCount(botJson='[]'):number{return (this.db.prepare("SELECT count(*) n FROM valued_events e LEFT JOIN identities i ON i.id=e.identity_id WHERE e.type='donation' AND e.rub_amount_minor IS NULL AND (i.id IS NULL OR i.match_key NOT IN(SELECT value FROM json_each(?)))").get(botJson) as {n:number}).n;}
}
