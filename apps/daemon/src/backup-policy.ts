const filename=/^stream-panel-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[a-f0-9]{8}\.spbk$/;
export const BACKUP_INTERVAL_MS=12*3600000;
export function backupTimestamp(name:string):number|null{
 const match=filename.exec(name);if(!match)return null;
 const at=Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
 return Number.isFinite(at)?at:null;
}
export function backupDue(last:number,now=Date.now()){return !last||now<last||now-last>=BACKUP_INTERVAL_MS;}
/** Seven daily points including today, then three older weekly windows within 30 days. */
export function retainedBackups(names:string[],now=Date.now(),preferred=''):Set<string>{
 const selected=new Map<number,{name:string;at:number}>(),keep=new Set<string>();
 const today=Math.floor((now+3*3600000)/86400000);
 for(const name of names){
  const at=backupTimestamp(name);if(at===null)continue;
  const age=today-Math.floor((at+3*3600000)/86400000);
  if(age<0){keep.add(name);continue;}if(age>=30)continue;
  const group=age<7?age:age<14?7:age<21?8:9;
  const previous=selected.get(group);
  if(!previous||at>previous.at||(at===previous.at&&(name===preferred||(previous.name!==preferred&&name>previous.name))))selected.set(group,{name,at});
 }
 for(const point of selected.values())keep.add(point.name);return keep;
}
