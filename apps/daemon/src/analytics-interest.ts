/** Per-browser leases prevent idle profiles from doing speculative report work. */
const viewers=new Map<string,{store:object;until:number}>();
export function analyticsInterest(store:object,viewer:string,active:boolean,now=Date.now()){
 if(!/^[a-zA-Z0-9_-]{1,64}$/.test(viewer))return;
 for(const [id,value] of viewers)if(value.until<=now)viewers.delete(id);
 viewers.delete(viewer);
 if(active)viewers.set(viewer,{store,until:now+330000});
 while(viewers.size>128)viewers.delete(viewers.keys().next().value!);
}
export function analyticsViewed(store:object,now=Date.now()){
 for(const [id,value] of viewers){if(value.until<=now)viewers.delete(id);else if(value.store===store)return true;}
 return false;
}
