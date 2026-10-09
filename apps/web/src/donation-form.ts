export function decimalAmount(minor:string):string {
 if(!/^\d+$/.test(minor))return '';
 const value=BigInt(minor);return `${value/100n}.${String(value%100n).padStart(2,'0')}`;
}
export function localDonationTime(at:number|null):string {
 if(at===null)return '';
 const d=new Date(at);if(!Number.isFinite(d.getTime()))return '';
 const pad=(n:number)=>String(n).padStart(2,'0');
 return `${String(d.getFullYear()).padStart(4,'0')}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function normalizedDonationAmount(value:string):string {
 const amount=value.trim();
 if(!/^(0|[1-9]\d*)(?:[.,]\d{1,2})?$/.test(amount))throw new Error('Укажите сумму с точностью до копеек');
 return amount.replace(',','.');
}
export function donationTimestamp(value:string,original:number|null=null):number|null {
 if(!value)return null;
 const canonical=/T\d{2}:\d{2}$/.test(value)?`${value}:00`:value;
 if(original!==null&&localDonationTime(original)===canonical)return original;
 if(!/^\d{4,6}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(canonical))throw new Error('Укажите корректные дату и время');
 const [year,...rest]=canonical.split('-');
 const iso=year!.length>4?`+${year!.padStart(6,'0')}-${rest.join('-')}`:canonical;
 const at=new Date(iso).getTime();
 if(!Number.isSafeInteger(at)||at<0||localDonationTime(at)!==canonical)throw new Error('Укажите корректные дату и время');
 return at;
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
