export const views=['overview','stream','sessions','people','analytics','connections','settings'] as const;
export type View=typeof views[number];
export interface Route {view:View;session:string;person:string;profile:'ruslan'|'gulnaz'}
export function readRoute(search:string,profile:Route['profile']='ruslan'):Route{
 const q=new URLSearchParams(search),view=q.get('view'),session=q.get('stream')??'';
 return {view:views.includes(view as View)&&!(view==='stream'&&!session)?view as View:'overview',session,person:q.get('person')??'',profile:q.get('profile')==='gulnaz'?'gulnaz':q.get('profile')==='ruslan'?'ruslan':profile};
}
export function routeUrl(route:Route):string{
 const q=new URLSearchParams({view:route.view,profile:route.profile});
 if(route.session)q.set('stream',route.session);if(route.person)q.set('person',route.person);
 return `/?${q}`;
}
