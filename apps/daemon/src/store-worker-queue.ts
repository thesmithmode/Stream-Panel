/** Preserve foreground FIFO and client lifetime barriers; only derived maintenance yields. */
export function nextStoreRequest<T extends {method:string;open?:boolean}>(queue:T[]):T{
 const barrier=queue.findIndex(m=>m.open||m.method==='close');
 const end=barrier<0?queue.length:barrier;
 const selected=queue.findIndex((m,i)=>i<end&&!['warmAnalytics','advanceAnalytics','preloadAnalytics'].includes(m.method));
 return queue.splice(selected<0?0:selected,1)[0]!;
}
