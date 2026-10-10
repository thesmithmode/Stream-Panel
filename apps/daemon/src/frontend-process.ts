import {fork,type ChildProcess} from 'node:child_process';
import type {HostedNetworkConfig} from './hosted-network.js';
/** Frontend crashes restart only the frontend, leaving collector connections alive. */
export class FrontendProcess{
 private child:ChildProcess|undefined;
 private stopped=false;
 private retry:NodeJS.Timeout|undefined;
 constructor(private root:string,private collectorPort:number,private port:number,private origin:string,private network:HostedNetworkConfig){}
 get pid(){return this.child?.pid;}
 async start():Promise<void>{
  if(this.stopped)return;
  const child=fork(new URL('./frontend-entry.js',import.meta.url),[this.root,String(this.collectorPort),String(this.port),this.origin,JSON.stringify(this.network)],{stdio:['ignore','ignore','inherit','ipc']});
  this.child=child;
  child.once('exit',()=>{
   if(this.child===child)this.child=undefined;
   if(!this.stopped)this.retry=setTimeout(()=>void this.start().catch(()=>{}),1000);
  });
  await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('FRONTEND_START_TIMEOUT'));},10000);
   const failed=()=>{clearTimeout(timer);reject(new Error('FRONTEND_START_FAILED'));};
   child.once('error',failed);child.once('exit',failed);
   child.once('message',message=>{if((message as {ready?:boolean}).ready){clearTimeout(timer);child.off('exit',failed);child.off('error',failed);resolve();}});
  });
 }
 async stop():Promise<void>{
  this.stopped=true;if(this.retry)clearTimeout(this.retry);
  const child=this.child;if(!child)return;
  await new Promise<void>(resolve=>{
   const timer=setTimeout(()=>child.kill('SIGKILL'),4000);
   child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');
  });
 }
}
