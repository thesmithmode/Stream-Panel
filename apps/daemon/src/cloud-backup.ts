import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,readFile,rm} from 'node:fs/promises';
import {BACKUP_STREAM_MAX_SIZE} from './backup-stream.js';
export const CLOUD_PART_SIZE=16*1024*1024;
const singleLimit=48*1024*1024;
const validName=/^stream-panel-[\dTZ-]+-[a-f0-9]{8}\.spbk$/;
const hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
type Part={name:string;size:number;sha256:string};
type Manifest={format:'stream-panel-chunks-v1';filename:string;size:number;sha256:string;parts:Part[]};
/** Immutable encrypted objects; publish the manifest only after every part verifies. */
export class CloudBackup {
 private base:string;private bucket:string;private secret='';
 constructor(private options:{url:string;serviceKeyFile?:string|undefined;bucket?:string|undefined},private request:typeof fetch=fetch){
  const url=new URL(options.url);this.base=url.origin;this.bucket=options.bucket??'stream-panel-backups';
  if(url.protocol!=='https:'||!url.hostname.endsWith('.supabase.co')||url.origin!==options.url||!options.serviceKeyFile)throw new Error('INVALID_BACKUP_REMOTE');
  if(!/^[a-z0-9-]{1,63}$/.test(this.bucket))throw new Error('INVALID_BACKUP_BUCKET');
 }
 private async call(path:string,method='GET',body?:BodyInit,type='application/json',missing=false){
  const response=await this.request(`${this.base}/storage/v1/${path}`,{method,headers:{Authorization:`Bearer ${this.secret}`,apikey:this.secret,'Content-Type':type},...(body===undefined?{}:{body}),signal:AbortSignal.timeout(60000)});
  if(missing&&response.status===404)return null;
  if(!response.ok)throw new Error('BACKUP_UPLOAD_FAILED');return response;
 }
 private async bytes(response:Response,limit:number){
  const size=Number(response.headers.get('content-length'));
  if(Number.isFinite(size)&&size>limit)throw new Error('BACKUP_SIZE_LIMIT');
  const reader=response.body?.getReader();if(!reader)return Buffer.alloc(0);
  const chunks:Uint8Array[]=[];let n=0;
  try{while(true){const next=await reader.read();if(next.done)break;n+=next.value.length;if(n>limit)throw new Error('BACKUP_SIZE_LIMIT');chunks.push(next.value);}return Buffer.concat(chunks,n);}
  finally{await reader.cancel();}
 }
 private async ready(){
  this.secret=(await readFile(this.options.serviceKeyFile!,'utf8')).trim();if(!this.secret)throw new Error('MISSING_BACKUP_SERVICE_KEY');
  const info=JSON.parse((await this.bytes((await this.call(`bucket/${this.bucket}`))!,1024*1024)).toString());
  if(info.public!==false)throw new Error('BACKUP_BUCKET_MUST_BE_PRIVATE');
 }
 private async put(name:string,bytes:Buffer,stored?:string[]){
  await this.call(`object/${this.bucket}/stream-panel/${name}`,'POST',new Uint8Array(bytes),'application/octet-stream');
  stored?.push(`stream-panel/${name}`);
  const remote=await this.bytes((await this.call(`object/authenticated/${this.bucket}/stream-panel/${name}`))!,bytes.length);
  if(hash(remote)!==hash(bytes))throw new Error('BACKUP_UPLOAD_VERIFY_FAILED');
 }
 async uploadFile(filename:string,path:string,blob?:Buffer){
  if(!validName.test(filename))throw new Error('BACKUP_NOT_FOUND');await this.ready();
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK),stored:string[]=[];
  try{
   const size=(await file.stat()).size;if(size>BACKUP_STREAM_MAX_SIZE)throw new Error('BACKUP_SIZE_LIMIT');
   if(size<=singleLimit)await this.put(filename,blob??await file.readFile(),stored);
   else{
    const manifest:Manifest={format:'stream-panel-chunks-v1',filename,size,sha256:'',parts:[]},digest=createHash('sha256');
    for(let offset=0;offset<size;){
     const bytes=Buffer.alloc(Math.min(CLOUD_PART_SIZE,size-offset));let read=0;
     while(read<bytes.length){const result=await file.read(bytes,read,bytes.length-read,offset+read);if(!result.bytesRead)throw new Error('BACKUP_INVALID');read+=result.bytesRead;}
     digest.update(bytes);const name=`${filename}.parts/${String(manifest.parts.length).padStart(4,'0')}.part`;
     await this.put(name,bytes,stored);manifest.parts.push({name,size:bytes.length,sha256:hash(bytes)});offset+=bytes.length;
    }
    manifest.sha256=digest.digest('hex');await this.put(`${filename}.manifest.json`,Buffer.from(JSON.stringify(manifest)),stored);
   }
  }catch(error){
   // Only objects whose immutable POST succeeded belong to this attempt.
   if(stored.length)await this.call(`object/${this.bucket}`,'DELETE',JSON.stringify({prefixes:stored})).catch(()=>{});
   throw error;
  }finally{await file.close();}
  await this.rotate(filename);
 }
 private async rotate(filename:string){
  const listed=JSON.parse((await this.bytes((await this.call(`object/list/${this.bucket}`,'POST',JSON.stringify({prefix:'stream-panel',limit:1000,offset:0,sortBy:{column:'name',order:'desc'}})))!,4*1024*1024)).toString());
  if(!Array.isArray(listed))throw new Error('BACKUP_INVALID_LIST');
  const owned=[...new Set(listed.map((x:{name:string})=>typeof x.name==='string'?x.name.replace(/\.manifest\.json$/,''):'').filter((n:string)=>validName.test(n)))].sort().reverse() as string[];
  if(!owned.includes(filename))throw new Error('BACKUP_UPLOAD_NOT_VERIFIED');
  const remove:string[]=[];
  for(const name of owned.slice(3)){
   if(listed.some((x:{name:string})=>x.name===`${name}.manifest.json`)){
    const parts=JSON.parse((await this.bytes((await this.call(`object/list/${this.bucket}`,'POST',JSON.stringify({prefix:`stream-panel/${name}.parts`,limit:1000,offset:0})))!,4*1024*1024)).toString());
    if(!Array.isArray(parts))throw new Error('BACKUP_INVALID_LIST');
    for(const part of parts)if(typeof part.name==='string'&&/^\d{4}\.part$/.test(part.name))remove.push(`stream-panel/${name}.parts/${part.name}`);
    remove.push(`stream-panel/${name}.manifest.json`);
   }else remove.push(`stream-panel/${name}`);
  }
  if(remove.length)await this.call(`object/${this.bucket}`,'DELETE',JSON.stringify({prefixes:remove}));
 }
 async downloadFile(filename:string,destination:string){
  if(!validName.test(filename))throw new Error('BACKUP_NOT_FOUND');await this.ready();
  const direct=await this.call(`object/authenticated/${this.bucket}/stream-panel/${filename}`,'GET',undefined,'application/json',true);
  const file=await open(destination,'wx',0o600);
  try{
   if(direct)await file.writeFile(await this.bytes(direct,singleLimit));
   else{
    const manifest=JSON.parse((await this.bytes((await this.call(`object/authenticated/${this.bucket}/stream-panel/${filename}.manifest.json`))!,1024*1024)).toString()) as Manifest;
    if(manifest.format!=='stream-panel-chunks-v1'||manifest.filename!==filename||!Number.isSafeInteger(manifest.size)||manifest.size<=singleLimit||manifest.size>BACKUP_STREAM_MAX_SIZE||!/^[a-f0-9]{64}$/.test(manifest.sha256)||!Array.isArray(manifest.parts)||manifest.parts.length!==Math.ceil(manifest.size/CLOUD_PART_SIZE))throw new Error('BACKUP_INVALID');
    const digest=createHash('sha256');let size=0;
    for(const [index,part]of manifest.parts.entries()){
     if(part.name!==`${filename}.parts/${String(index).padStart(4,'0')}.part`||part.size!==Math.min(CLOUD_PART_SIZE,manifest.size-size)||!/^[a-f0-9]{64}$/.test(part.sha256))throw new Error('BACKUP_INVALID');
     const bytes=await this.bytes((await this.call(`object/authenticated/${this.bucket}/stream-panel/${part.name}`))!,part.size);
     if(bytes.length!==part.size||hash(bytes)!==part.sha256)throw new Error('BACKUP_UPLOAD_VERIFY_FAILED');
     await file.writeFile(bytes);digest.update(bytes);size+=bytes.length;
    }
    if(digest.digest('hex')!==manifest.sha256)throw new Error('BACKUP_UPLOAD_VERIFY_FAILED');
   }
   await file.sync();
  }catch(error){await rm(destination,{force:true});throw error;}finally{await file.close();}
 }
}
