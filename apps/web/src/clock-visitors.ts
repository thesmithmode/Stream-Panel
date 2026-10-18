export type VisitorPage={items:{id:string;name:string;sources?:string[];visits:number}[];total:number;offset:number;limit:number};
type Loader=(params:Record<string,string|number>,signal:AbortSignal)=>Promise<{clockPages?:{minute:number;page:VisitorPage}[];clockVisitors?:VisitorPage}>;
/** One bounded cache per report snapshot; selection changes never cancel shared prefetches. */
export class ClockVisitors {
 private controller=new AbortController();
 private chunks=new Map<string,{pages:Map<number,VisitorPage>;bytes:number}>();
 private pending=new Map<string,Promise<Map<number,VisitorPage>>>();
 private bytes=0;
 private load:Loader;
 constructor(load:Loader){this.load=load;}
 private async chunk(day:string,resolution:number,minute:number){
  this.controller.signal.throwIfAborted();
  const start=Math.floor(minute/(48*resolution))*48*resolution,key=`${day}:${resolution}:${start}`;
  const cached=this.chunks.get(key);if(cached)return cached.pages;
  const pending=this.pending.get(key);if(pending)return pending;
  const task=(async()=>{
   const result=await this.load({clockDay:day,clockResolution:resolution,clockMinute:start,clockBatch:1},this.controller.signal);
   this.controller.signal.throwIfAborted();
   const pages=new Map((result.clockPages??[]).map(p=>[p.minute,p.page]));
   const bytes=JSON.stringify(result).length*2;
   if(bytes<=8*1024*1024){
    while(this.chunks.size>=32||this.bytes+bytes>8*1024*1024){const oldest=this.chunks.keys().next().value!;this.bytes-=this.chunks.get(oldest)!.bytes;this.chunks.delete(oldest);}
    this.chunks.set(key,{pages,bytes});this.bytes+=bytes;
   }
   return pages;
  })();
  this.pending.set(key,task);
  try{return await task;}finally{this.pending.delete(key);}
 }
 async page(day:string,resolution:number,minute:number,offset=0):Promise<VisitorPage>{
  if(offset)return (await this.load({clockDay:day,clockResolution:resolution,clockMinute:minute,clockOffset:offset},this.controller.signal)).clockVisitors!;
  return (await this.chunk(day,resolution,minute)).get(minute)??{items:[],total:0,offset:0,limit:100};
 }
 async prefetch(day:string,resolution:number){
  // Whole-day first pages are small at 15/30/60m. Fine grids warm only requested chunks.
  if(resolution<15)return;
  for(let minute=0;minute<1440;minute+=48*resolution){this.controller.signal.throwIfAborted();await this.chunk(day,resolution,minute);}
 }
 close(){this.controller.abort();this.chunks.clear();this.pending.clear();this.bytes=0;}
}
