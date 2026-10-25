import type {StreamStore} from './store.js';
type Identity={id:string;source:string;display_name:string;match_key:string};
type Detail={id:string;revision:number;display_name:string;identities:Identity[];aliases:{identity_id:string;name:string;candidate_key:string}[]};
const key=(value:string)=>value.normalize('NFKC').trim().toLowerCase();
const donorNames=new Set(['egor4ik','егор4ик']);
/** Owner-confirmed repair (2026-10-25), deliberately not a fuzzy auto-link rule.
 * Only a sole DA-only duplicate and the known Twitch account may be joined.
 * The existing reversible merge journal retains all original facts. */
export function repairConfirmedPerson(store:Pick<StreamStore,'persons'|'person'|'merge'>){
 const rows=[...new Map(['chikist007','Egor4ik','Егор4ик'].flatMap(name=>store.persons(name)).map(row=>[String(row.id),row])).values()];
 const people=rows.map(row=>store.person(String(row.id),false) as unknown as Detail);
 const targets=people.filter(person=>{
  const twitch=new Set(person.identities.filter(i=>i.source==='twitch').map(i=>i.id));
  return person.identities.some(i=>i.source==='twitch'&&[i.display_name,i.match_key].some(n=>key(n)==='chikist007'))||person.aliases.some(a=>twitch.has(a.identity_id)&&[a.name,a.candidate_key].some(n=>key(n)==='chikist007'));
 });
 if(targets.length!==1)return {state:targets.length?'ambiguous':'not-found'} as const;
 const target=targets[0]!;
 const donors=people.filter(person=>person.id!==target.id&&donorNames.has(key(person.display_name))&&person.identities.length>0&&person.identities.every(i=>i.source==='donationalerts'&&donorNames.has(key(i.display_name))));
 if(donors.length!==1)return {state:donors.length?'ambiguous':'already-linked-or-absent'} as const;
 const source=donors[0]!;
 const mergeId=store.merge(source.id,target.id,source.revision,target.revision,Date.now());
 return {state:'merged',mergeId} as const;
}
