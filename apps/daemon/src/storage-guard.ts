import {statfs} from 'node:fs/promises';import {dirname} from 'node:path';
/** Soft cleanup threshold, not a cutoff for stream collection. */
export const STORAGE_RESERVE_BYTES=1024*1024*1024;
export const STORAGE_MIN_FREE_BYTES=16*1024*1024;
export class StorageGuard {
 private cleanupFailed=false;private checkedAt=0;private freeBytes:number|null=null;private pending:Promise<void>|null=null;
 constructor(private path:string,private free:()=>Promise<number>=async()=>{const info=await statfs(dirname(path));return info.bavail*info.bsize;},private now:()=>number=Date.now,private cleanup:()=>Promise<void>=async()=>{}){}
 setCleanup(cleanup:()=>Promise<void>){this.cleanup=cleanup;}
 status(){return {freeBytes:this.freeBytes,checkedAt:this.checkedAt,reserveBytes:STORAGE_RESERVE_BYTES,minFreeBytes:STORAGE_MIN_FREE_BYTES,cleanupFailed:this.cleanupFailed};}
 async check(){
  if(this.path===':memory:')return;
  if(this.freeBytes===null||this.now()-this.checkedAt>=5000){
   if(!this.pending)this.pending=(async()=>{
    let bytes=await this.free();
    if(bytes<STORAGE_RESERVE_BYTES){try{await this.cleanup();this.cleanupFailed=false;}catch{this.cleanupFailed=true;}bytes=await this.free();}
    this.freeBytes=bytes;this.checkedAt=this.now();
   })().finally(()=>this.pending=null);
   await this.pending;
  }
  if(this.freeBytes!<STORAGE_MIN_FREE_BYTES)throw new Error('STORAGE_FULL');
 }
}
