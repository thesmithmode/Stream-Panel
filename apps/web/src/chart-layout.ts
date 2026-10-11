/** Keep minute detail within a bounded page, even when broadcasts are days apart. */
export function chartPages<T extends {at:number}>(points:T[]):T[][] {
 const pages:T[][]=[];
 for(let end=points.length;end>0;){
  let start=end-1;const earliest=points[start]!.at-359*60000;
  while(start>0&&end-start<360&&points[start-1]!.at>=earliest)start--;
  pages.push(points.slice(start,end));end=start;
 }
 return pages;
}
/** Fit the visible period on screen; never aggregate beyond five minutes. */
export function chartLayout(from:number,to:number,width:number,requested=0){
 const plotWidth=Math.max(280,width||800),capacity=Math.max(1,Math.floor((plotWidth-50)/10));
 const fit=Math.max(1,Math.ceil((to-from)/60000/capacity));
 const resolution=Math.min(5,Math.max(1,Number.isFinite(requested)?requested:0,fit));
 return {plotWidth,resolution,labelEvery:Math.max(1,Math.ceil((to-from)/(15*60000)/Math.max(2,Math.floor(plotWidth/80))))};
}
