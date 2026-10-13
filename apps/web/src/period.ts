export type Period=number|'all'|'custom';
export const standardPeriods=[7,30] as const;
export function periodRange(period:Period,now=Date.now()){return {from:typeof period==='number'?now-period*86400000:0,to:now};}
export function platformClass(sources:string|string[]|null|undefined){const platforms=(Array.isArray(sources)?sources:(sources??'').split(',')).filter(s=>s==='twitch'||s==='youtube');return new Set(platforms).size===1?platforms[0]!:'';}
