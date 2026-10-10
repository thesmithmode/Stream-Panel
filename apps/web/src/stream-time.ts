const clock=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export const streamTime=(at:number)=>clock.format(at);
export const streamRange=(from:number,to:number|null)=>`${streamTime(from)} — ${to===null?'в эфире':streamTime(to)}`;
