const clock=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export const streamTime=(at:number)=>clock.format(at);
export const streamRange=(from:number,to:number|null)=>`${streamTime(from)} — ${to===null?'в эфире':streamTime(to)}`;

const shortClock=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
/** Dates are useful only when the containing stream spans Moscow calendar days. */
export function intervalRange(from:number,to:number,streamStart:number,streamEnd:number):string {
 return streamTime(streamStart).slice(0,10)===streamTime(streamEnd).slice(0,10)?`${shortClock.format(from)} — ${shortClock.format(to)}`:streamRange(from,to);
}

/** Compact card metadata; keep both dates for broadcasts crossing midnight. */
export function compactStreamRange(from:number,to:number|null):string {
 const day=(at:number)=>new Date(at).toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long'});
 const first=`${day(from)} · ${shortClock.format(from)}`;
 if(to===null)return `${first} — в эфире`;
 return `${first}–${streamTime(from).slice(0,10)===streamTime(to).slice(0,10)?shortClock.format(to):`${day(to)} · ${shortClock.format(to)}`}`;
}
