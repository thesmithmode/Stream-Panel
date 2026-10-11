export function decimalAmount(minor:string):string {
 if(!/^\d+$/.test(minor))return '';
 const value=BigInt(minor);return `${value/100n}.${String(value%100n).padStart(2,'0')}`;
}
export function donationAuditChanges(beforeJson:string,afterJson:string):{label:string;before:string|null;after:string}[] {
 const before=JSON.parse(beforeJson) as Record<string,unknown>|null,after=JSON.parse(afterJson) as Record<string,unknown>;
 const showTime=(value:unknown)=>typeof value==='number'?new Date(value).toLocaleString('ru-RU'):'Время неизвестно';
 const showMoney=(row:Record<string,unknown>)=>`${decimalAmount(String(row.amountMinor??''))||'—'} ${String(row.currency??'')}`.trim();
 const fields:[string,string,(row:Record<string,unknown>)=>string][]=[
  ['amount','Сумма',showMoney],['personName','Получатель',row=>String(row.personName??'Аноним')],
  ['occurredAtMs','Дата доната',row=>showTime(row.occurredAtMs)],['sourceName','Источник',row=>String(row.sourceName??'')],['message','Сообщение',row=>String(row.message??'')]
 ];
 return fields.flatMap(([key,label,format])=>{
  const changed=before===null||(key==='amount'?before.amountMinor!==after.amountMinor||before.currency!==after.currency:before[key]!==after[key]);
  return changed?[{label,before:before===null?null:format(before),after:format(after)}]:[];
 });
}
