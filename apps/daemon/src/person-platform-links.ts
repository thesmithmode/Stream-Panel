export interface PlatformIdentity {id:string;source:string;external_id:string}
export interface PlatformLink {identityId:string;source:'twitch'|'youtube';url:string}
type Login={id:string;login:string};

/** Public profile addresses only; names and donor aliases are never URL identifiers. */
export class PersonPlatformLinks {
 private cache=new Map<string,{until:number;login:string|null}>();
 private scope='';
 constructor(private resolve:(ids:string[])=>Promise<Login[]>,private now:()=>number=Date.now){}
 async list(identities:PlatformIdentity[],scope:string):Promise<PlatformLink[]> {
  if(scope!==this.scope){this.scope=scope;this.cache.clear();}
  const ids=[...new Set(identities.filter(i=>i.source==='twitch'&&/^\d+$/.test(i.external_id)).map(i=>i.external_id))];
  const resolved=new Map(ids.map(id=>[id,this.cache.get(id)]));
  const missing=scope?ids.filter(id=>(this.cache.get(id)?.until??0)<=this.now()):[];
  for(let start=0;start<missing.length;start+=100){
   const batch=missing.slice(start,start+100);
   let users:Login[]=[];
   try{users=await this.resolve(batch);}catch{/* A provider outage must not hide the local card. */}
   if(scope!==this.scope)return [];
   for(const id of batch){
    const login=users.find(user=>user.id===id&&/^[a-zA-Z0-9_]{1,25}$/.test(user.login))?.login??null;
    this.cache.delete(id);
    this.cache.set(id,{login,until:this.now()+(login?3600000:60000)});
    resolved.set(id,this.cache.get(id));
   }
   while(this.cache.size>500)this.cache.delete(this.cache.keys().next().value!);
  }
  return identities.flatMap<PlatformLink>(identity=>{
   if(identity.source==='youtube'&&/^UC[a-zA-Z0-9_-]{22}$/.test(identity.external_id))
    return [{identityId:identity.id,source:'youtube' as const,url:`https://www.youtube.com/channel/${identity.external_id}`}];
   const cached=scope&&identity.source==='twitch'?resolved.get(identity.external_id):undefined;
   return cached?.login&&cached.until>this.now()?[{identityId:identity.id,source:'twitch' as const,url:`https://www.twitch.tv/${cached.login}`}]:[];
  });
 }
}
