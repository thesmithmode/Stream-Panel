import type {CurrentChat,CurrentChatter} from '../../../packages/core/src/current-chat';
export type {CurrentChat,CurrentChatter};
export type ChatSort='name'|'minutes'|'messages'|'lastMessageAt';
export function sortChat(people:readonly CurrentChatter[],search:string,sort:ChatSort,descending:boolean){
 const term=search.trim().replace(/^@/,'').toLocaleLowerCase('ru');
 return people.filter(p=>p.name.toLocaleLowerCase('ru').includes(term)).sort((a,b)=>{
  const av=a[sort],bv=b[sort];
  // Unknown duration and no messages remain last in either direction.
  if(av===null||bv===null){if(av!==bv)return av===null?1:-1;}
  const order=sort==='name'?a.name.localeCompare(b.name,'ru'):Number(av)-Number(bv);
  return (descending?-1:1)*order||a.name.localeCompare(b.name,'ru')||a.key.localeCompare(b.key);
 });
}
export function messageAge(at:number|null,now:number){
 if(at===null)return 'Не писал';
 const minutes=Math.max(0,Math.floor((now-at)/60000));
 if(minutes===0)return 'Только что';
 return minutes<60?`${minutes} мин назад`:`${Math.floor(minutes/60)} ч${minutes%60?` ${minutes%60} мин`:''} назад`;
}
