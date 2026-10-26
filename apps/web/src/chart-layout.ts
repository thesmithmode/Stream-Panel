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

/** Integer count axes use readable steps and leave headroom above the measured peak. */
export function countAxis(maximum:number){
 const peak=Number.isFinite(maximum)?Math.max(1,maximum):1;
 const power=10**Math.floor(Math.log10(peak/5));
 const step=Math.max(1,[1,2,5,10].map(n=>n*power).find(n=>n>=peak/5)!);
 const high=Math.ceil(peak/step)*step;
 return {maximum:high,ticks:Array.from({length:Math.round(high/step)+1},(_,i)=>i*step)};
}
