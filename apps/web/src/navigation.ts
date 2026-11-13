// Use the browser's own history so toolbar Back, browser Back and Forward agree.
// The marker bounds Back to this app's entries, including after a reload.
interface NavigationEntry {depth:number;scroll:number}
function entry():NavigationEntry|undefined {return history.state?.spNavigation;}
export function initializeNavigation(){
 if(!entry())history.replaceState({...history.state,spNavigation:{depth:0,scroll:window.scrollY}},'');
}
export function rememberScroll(){
 const current=entry();if(current)history.replaceState({...history.state,spNavigation:{...current,scroll:window.scrollY}},'');
}
export function saveNavigation(url:string,replace=false){
 initializeNavigation();
 if(location.pathname+location.search===url)return;
 rememberScroll();
 const current=entry()!;
 const state={...history.state,spNavigation:{depth:current.depth+(replace?0:1),scroll:window.scrollY}};
 if(replace)history.replaceState(state,'',url);else history.pushState(state,'',url);
}
export function canGoBack(){return (entry()?.depth??0)>0&&history.length>1;}
export function navigationScroll(){return entry()?.scroll??0;}
