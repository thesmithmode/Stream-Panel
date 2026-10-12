const clock=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export const streamTime=(at:number)=>clock.format(at);
export const streamRange=(from:number,to:number|null)=>`${streamTime(from)} — ${to===null?'в эфире':streamTime(to)}`;

const shortClock=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
/** Dates are useful only when the containing stream spans Moscow calendar days. */
export function intervalRange(from:number,to:number,streamStart:number,streamEnd:number):string {
 return streamTime(streamStart).slice(0,10)===streamTime(streamEnd).slice(0,10)?`${shortClock.format(from)} — ${shortClock.format(to)}`:streamRange(from,to);
}
