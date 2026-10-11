import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat,open} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {CloudBackup,CLOUD_PART_SIZE} from '../src/cloud-backup.js';
const filename='stream-panel-2099-01-08T00-00-00-000Z-12345678.spbk';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
test('cloud backup bounds remote bodies, validates immutable object names and rotates only owned verified archives',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-cloud-guards-')),service=join(dir,'key'),source=join(dir,'local');await writeFile(service,'fixture');await writeFile(source,'encrypted fixture');
 const options={url:'https://fixture.supabase.co',serviceKeyFile:service};
 try{
  for(const opts of [{...options,url:'http://fixture.supabase.co'},{...options,url:'https://evil.test'},{...options,url:options.url+'/'},{url:options.url},{...options,bucket:'../other'}])assert.throws(()=>new CloudBackup(opts),/INVALID_BACKUP/);
  const noRequest:typeof fetch=async()=>{throw new Error('unexpected request');};
  const c=new CloudBackup(options,noRequest);await assert.rejects(c.uploadFile('../key',source),/BACKUP_NOT_FOUND/);await assert.rejects(c.downloadFile('../key',join(dir,'no')),/BACKUP_NOT_FOUND/);
  await writeFile(service,'');await assert.rejects(c.uploadFile(filename,source),/MISSING_BACKUP_SERVICE_KEY/);await writeFile(service,'fixture');
  for(const mode of ['private','empty','http','length','stream','invalid-list','missing-list','bad-parts','rotate','valid']){
   let uploaded:Buffer|undefined;const deletes:string[]=[];
   const old='stream-panel-2099-01-01T00-00-00-000Z-12345678.spbk';
   const request:typeof fetch=async(input,init)=>{
    const p=new URL(String(input)).pathname;
    if(p.includes('/bucket/')){
     if(mode==='empty')return new Response(null);if(mode==='http')return Response.json({},{status:503});
     if(mode==='length')return new Response('{}',{headers:{'content-length':String(2*1024*1024)}});
     if(mode==='stream')return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(2*1024*1024));c.close();}}));
     return Response.json({public:mode==='private'});
    }
    if(p.includes('/object/authenticated/'))return new Response(new Uint8Array(uploaded!));
    if(p.includes('/object/list/')){
     const prefix=JSON.parse(String(init?.body)).prefix;
     if(prefix.endsWith('.parts'))return Response.json(mode==='bad-parts'?{}:[{name:'0000.part'},{name:'../unrelated'}]);
     if(mode==='invalid-list')return Response.json({});if(mode==='missing-list')return Response.json([]);
     const names=mode==='rotate'||mode==='bad-parts'?[filename,...[7,6,5,4].map(day=>`stream-panel-2099-01-0${day}T00-00-00-000Z-12345678.spbk`),'stream-panel-2099-01-03T00-00-00-000Z-12345678.spbk','stream-panel-2099-01-02T00-00-00-000Z-12345678.spbk',old+'.manifest.json','stream-panel-2098-12-31T00-00-00-000Z-12345678.spbk']:[filename];
     return Response.json([...names.map(name=>({name})),{name:'unrelated'},{name:33}]);
    }
    if(init?.method==='DELETE')deletes.push(...JSON.parse(String(init.body)).prefixes);
    else uploaded=Buffer.from(init?.body as Uint8Array);return Response.json({});
   };
   const cloud=new CloudBackup(options,request);
   if(['valid','rotate'].includes(mode)){await cloud.uploadFile(filename,source);assert.ok(uploaded);const target=join(dir,mode);await cloud.downloadFile(filename,target);assert.equal(await readFile(target,'utf8'),'encrypted fixture');if(mode==='rotate')assert.deepEqual(deletes,[`stream-panel/${old}.parts/0000.part`,`stream-panel/${old}.manifest.json`,'stream-panel/stream-panel-2098-12-31T00-00-00-000Z-12345678.spbk']);}
   else await assert.rejects(cloud.uploadFile(filename,source));
  }
  const sparse=await open(source,'w');await sparse.truncate(2*1024*1024*1024+1);await sparse.close();
  await assert.rejects(new CloudBackup(options,async()=>Response.json({public:false})).uploadFile(filename,source),/BACKUP_SIZE_LIMIT/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('chunk manifests reject traversal, invalid lengths and checksums without leaving a downloaded file',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-cloud-manifest-')),service=join(dir,'key');await writeFile(service,'fixture');
 const zero=Buffer.alloc(CLOUD_PART_SIZE),tail=Buffer.alloc(17),hash=createHash('sha256');for(let n=0;n<3;n++)hash.update(zero);hash.update(tail);
 const baseline={format:'stream-panel-chunks-v1',filename,size:3*CLOUD_PART_SIZE+17,sha256:hash.digest('hex'),parts:Array.from({length:4},(_,n)=>({name:`${filename}.parts/${String(n).padStart(4,'0')}.part`,size:n===3?17:CLOUD_PART_SIZE,sha256:sha(n===3?tail:zero)}))};
 try{
  for(const mode of ['format','filename','size','large','integer','hash','parts','count','path','part-size','part-hash','short','checksum','total-checksum','valid','existing']){
   const data=structuredClone(baseline);if(mode==='format')data.format='other';if(mode==='filename')data.filename='../key';if(mode==='size')data.size=1;if(mode==='large')data.size=3*1024*1024*1024;if(mode==='integer')data.size=NaN;if(mode==='hash')data.sha256='wrong';if(mode==='parts')(data as any).parts={};if(mode==='count')data.parts.pop();if(mode==='path')data.parts[0]!.name='../key';if(mode==='part-size')data.parts[0]!.size--;if(mode==='part-hash')data.parts[0]!.sha256='wrong';if(mode==='total-checksum')data.sha256='f'.repeat(64);
   const request:typeof fetch=async input=>{const p=new URL(String(input)).pathname;if(p.includes('/bucket/'))return Response.json({public:false});if(p.endsWith(filename))return Response.json({},{status:404});if(p.endsWith('.manifest.json'))return Response.json(data);if(mode==='short')return new Response(new Uint8Array(0));if(mode==='checksum')return new Response(new Uint8Array(Buffer.alloc(CLOUD_PART_SIZE,1)));return new Response(new Uint8Array(p.endsWith('0003.part')?tail:zero));};
   const cloud=new CloudBackup({url:'https://fixture.supabase.co',serviceKeyFile:service},request),destination=join(dir,mode);
   if(mode==='valid'){await cloud.downloadFile(filename,destination);assert.equal((await stat(destination)).size,baseline.size);}
   else if(mode==='existing'){await writeFile(destination,'keep');await assert.rejects(cloud.downloadFile(filename,destination),{code:'EEXIST'});assert.equal(await readFile(destination,'utf8'),'keep');}
   else {await assert.rejects(cloud.downloadFile(filename,destination));await assert.rejects(stat(destination),/ENOENT/);}
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
