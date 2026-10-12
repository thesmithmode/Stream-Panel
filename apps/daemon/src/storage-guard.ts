import {statfs} from 'node:fs/promises';import {dirname} from 'node:path';
export const STORAGE_RESERVE_BYTES=1024*1024*1024;
/** Protect the shared filesystem; only this application's writes are stopped. */
export class StorageGuard {
 private checkedAt=0;private freeBytes:number|null=null;private pending:Promise<void>|null=null;
 constructor(private path:string,private free:()=>Promise<number>=async()=>{const info=await statfs(dirname(path));return info.bavail*info.bsize;},private now:()=>number=Date.now){}
 status(){return {freeBytes:this.freeBytes,checkedAt:this.checkedAt,reserveBytes:STORAGE_RESERVE_BYTES};}
 async check(){
  if(this.path===':memory:')return;
  if(this.freeBytes===null||this.now()-this.checkedAt>=5000){
   if(!this.pending)this.pending=this.free().then(bytes=>{this.freeBytes=bytes;this.checkedAt=this.now();}).finally(()=>this.pending=null);
   await this.pending;
  }
  if(this.freeBytes!<STORAGE_RESERVE_BYTES)throw new Error('STORAGE_RESERVE_LOW');
 }
}
