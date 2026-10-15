/** Keep minute detail within a bounded page, even when broadcasts are days apart. */
export function chartPages<T extends {at:number}>(points:T[],resolutionMinutes=1):T[][] {
 const pages:T[][]=[];
 for(let end=points.length;end>0;){
  let start=end-1;const earliest=points[start]!.at-359*60000*resolutionMinutes;
  while(start>0&&end-start<360&&points[start-1]!.at>=earliest)start--;
  pages.push(points.slice(start,end));end=start;
 }
 return pages;
}
/** Fit the plot on screen without changing the selected interval. */
export function chartLayout(from:number,to:number,width:number,requested=1){
 const plotWidth=Math.max(280,width||800);
 const resolution=[1,5,15,1440].includes(requested)?requested:1;
 return {plotWidth,resolution,labelEvery:Math.max(1,Math.ceil((to-from)/(15*60000)/Math.max(2,Math.floor(plotWidth/80))))};
}
