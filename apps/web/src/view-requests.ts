import type {View} from './route';
/** Fetch only data rendered by this screen. Profile scope remains in API headers. */
export function viewRequests(view:View,session:string):[string,string][] {
 const query=session?`?session=${encodeURIComponent(session)}`:'';
 const reads:Record<View,string[]>={overview:[],stream:['sessions','events','summary'],people:['sessions','persons'],sessions:['sessions'],analytics:[],connections:[]};
 return ['status',...reads[view]].map(key=>[key,key+((key==='events'||key==='summary')&&view==='stream'?query:'')+(key==='summary'?`${query?'&':'?'}compact=1`:'')]);
}
