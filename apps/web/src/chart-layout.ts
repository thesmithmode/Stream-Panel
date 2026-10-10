/** Fit the full period on screen; selecting a bucket still offers its individual minutes. */
export function chartLayout(from:number,to:number,width:number,requested=0){
 const plotWidth=Math.max(280,width||800),capacity=Math.max(1,Math.floor((plotWidth-50)/10));
 const fit=Math.max(1,Math.ceil((to-from)/60000/capacity));
 const resolution=Math.max(Number.isFinite(requested)?requested:0,fit);
 return {plotWidth,resolution,labelEvery:Math.max(1,Math.ceil((to-from)/(15*60000)/Math.max(2,Math.floor(plotWidth/80))))};
}
