export const views=['overview','stream','sessions','people','analytics','donations','connections','settings'] as const;
export type View=typeof views[number];
export interface Route {view:View;session:string;person:string;profile:'ruslan'|'gulnaz';section?:string;returnTo?:string;period?:string|undefined}
export function readRoute(search:string,profile:Route['profile']='ruslan'):Route{
 const q=new URLSearchParams(search),view=q.get('view'),session=q.get('stream')??'';
 return {view:views.includes(view as View)&&!(view==='stream'&&!session)?view as View:'overview',session,person:q.get('person')??'',...(q.get('section')?{section:q.get('section')!}:{}),...(q.get('period')?{period:q.get('period')!}:{}),...(safeReturn(q.get('returnTo'))?{returnTo:safeReturn(q.get('returnTo'))!}:{}),profile:q.get('profile')==='gulnaz'?'gulnaz':q.get('profile')==='ruslan'?'ruslan':profile};
}
export function safeReturn(value:string|null):string|undefined{
 if(!value?.startsWith('/?')||value.length>2048)return;
 const q=new URLSearchParams(value.slice(2));
 if(!views.includes(q.get('view') as View)||q.has('returnTo'))return;
 return value;
}
export function routeUrl(route:Route):string{
 const q=new URLSearchParams({view:route.view,profile:route.profile});
 if(route.session)q.set('stream',route.session);if(route.person)q.set('person',route.person);
 if(route.section)q.set('section',route.section);if(route.period)q.set('period',route.period);if(safeReturn(route.returnTo??null))q.set('returnTo',route.returnTo!);
 return `/?${q}`;
}
