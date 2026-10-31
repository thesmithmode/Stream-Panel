type Identity={id:string;source:string;external_id:string;account_id:string;display_name:string};
/** Ledger entries describe donation assignments, never an external user account. */
export function personAccounts(identities:readonly Identity[],personName:string){
 const groups=new Map<string,{id:string;ids:string[];source:string;display_name:string;aliases:string[]}>();
 for(const identity of identities){
  if(identity.account_id.startsWith('correction:')||identity.account_id.startsWith('manual:')||identity.external_id==='anonymous:donor')continue;
  const key=identity.source==='donationalerts'?'donationalerts':`${identity.source}:${identity.external_id}`;
  const row=groups.get(key)??{id:identity.id,ids:[],source:identity.source,display_name:identity.source==='donationalerts'?personName:identity.display_name,aliases:[]};
  row.ids.push(identity.id);if(identity.display_name!==row.display_name&&!row.aliases.includes(identity.display_name))row.aliases.push(identity.display_name);
  groups.set(key,row);
 }
 return [...groups.values()];
}
