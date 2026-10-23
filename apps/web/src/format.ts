/** Display-only formatting; server timestamps and calculations stay unchanged. */
export const num=(value:number,digits=1)=>value.toLocaleString('ru-RU',{maximumFractionDigits:digits});
export const pct=(fraction:number)=>`${num(fraction*100,fraction*100<10?1:0)}%`;
export function dateTime(at:number){
 const currentYear=new Date().toLocaleDateString('en',{timeZone:'Europe/Moscow',year:'numeric'});
 const year=new Date(at).toLocaleDateString('en',{timeZone:'Europe/Moscow',year:'numeric'});
 return new Date(at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long',...(year===currentYear?{}:{year:'numeric'}),hour:'2-digit',minute:'2-digit'});
}
