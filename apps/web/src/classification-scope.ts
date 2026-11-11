type Person={id:string;is_bot?:boolean|number;is_human?:boolean;is_donor?:boolean};
/** Reordered rows and fresh attendance values do not change classification facts. */
export function classificationScope(profile:string,revision:number,version:string,people:readonly Person[]){
 return JSON.stringify([profile,revision,version,people.map(p=>[p.id,!!p.is_bot,!!p.is_human,!!p.is_donor]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]);
}
