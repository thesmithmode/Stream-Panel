/** Exact minor-unit rate, rounded to the nearest minor unit; unknown input stays unknown. */
export function minorPerHour(amountMinor:string,durationMs:number):string|null {
 if(!/^\d+$/.test(amountMinor)||!Number.isSafeInteger(durationMs)||durationMs<=0)return null;
 const elapsed=BigInt(durationMs);
 return ((BigInt(amountMinor)*3600000n+elapsed/2n)/elapsed).toString();
}
export function currencyRates(totals:Record<string,string>,durationMs:number):Record<string,string|null> {
 return Object.fromEntries(Object.entries(totals).map(([currency,total])=>[currency,minorPerHour(total,durationMs)]));
}
