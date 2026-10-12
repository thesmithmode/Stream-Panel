import {STORAGE_MIN_FREE_BYTES} from './storage-guard.js';
import Database from "better-sqlite3";
import {CloudBackup} from "./cloud-backup.js";
import {retainedBackups,backupDue} from "./backup-policy.js";
import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile, readdir, rm, stat, statfs, lstat, rename, open } from "node:fs/promises";
import {constants} from "node:fs";
import {createReadStream,createWriteStream} from "node:fs";
import {pipeline} from "node:stream/promises";
import {BACKUP_STREAM_MAX_SIZE,sealBackupFile,openBackupFile} from "./backup-stream.js";
import { join,resolve } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../../../packages/core/src/schema.js";
const magic = Buffer.from("SPBK1");
const maxSize = 48 * 1024 * 1024;
const maxPayloadSize = 64 * 1024 * 1024;
const profiles = ["ruslan", "gulnaz"] as const;
const backupFilename=/^stream-panel-[\dTZ-]+-[a-f0-9]{8}\.spbk$/;
type BackupChannelStatus = { state: string; lastSuccessAt: number; filename: string; error: string };
type BackupStatus = { pendingUploads:number;nextRetryAt:number;state: string; lastSuccessAt: number; filename: string; error: string; local: BackupChannelStatus; cloud: BackupChannelStatus };
function schemaSignature(db:Database.Database):string {
  const profiles=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sp_profile_schema'").get()
    ?db.prepare('SELECT profile,version FROM sp_profile_schema ORDER BY profile').all():[];
  const objects=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  return createHash('sha256').update(JSON.stringify({version:db.pragma('user_version',{simple:true}),profiles,objects})).digest('hex');
}
export function validateSnapshot(db: Database.Database): void {
  if (db.pragma("integrity_check", {simple:true}) !== "ok" ||
      (db.pragma("foreign_key_check") as unknown[]).length)
    throw new Error("BACKUP_INTEGRITY_FAILED");
  const versions = [db.pragma("user_version", {simple:true})];
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sp_profile_schema'").get())
    versions.push(...(db.prepare("SELECT version FROM sp_profile_schema").all() as {version:number}[]).map(row=>row.version));
  if (versions.some(version => !Number.isInteger(version) || Number(version)<0 || Number(version)>CURRENT_SCHEMA_VERSION))
    throw new Error("UNSUPPORTED_SCHEMA_VERSION");
}
export function sealBackup(payload: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error("INVALID_BACKUP_KEY");
  if (payload.length > maxPayloadSize) throw new Error("BACKUP_SIZE_LIMIT");
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const compressed = gzipSync(payload);
  return Buffer.concat([magic, iv, cipher.update(compressed), cipher.final(), cipher.getAuthTag()]);
}
export function openBackup(blob: Buffer, key: Buffer): Buffer {
  if (key.length !== 32 || blob.length < 33 || !blob.subarray(0, 5).equals(magic)) throw new Error("INVALID_BACKUP");
  const cipher = createDecipheriv("aes-256-gcm", key, blob.subarray(5, 17));
  cipher.setAuthTag(blob.subarray(-16));
  return gunzipSync(Buffer.concat([cipher.update(blob.subarray(17, -16)), cipher.final()]), { maxOutputLength: maxPayloadSize });
}
export class BackupService {
  status: BackupStatus = {
    pendingUploads:0,nextRetryAt:0,state: "disabled", lastSuccessAt: 0, filename: "", error: "",
    local: { state: "pending", lastSuccessAt: 0, filename: "", error: "" },
    cloud: { state: "disabled", lastSuccessAt: 0, filename: "", error: "" },
  };
  private uploading:string|undefined;
  private purgeTask:Promise<void>|undefined;
  private active: Promise<{filename:string;cloudError?:string}> | undefined;
  private uploadTask:Promise<void>|undefined;
  private stateTask:Promise<void>|undefined;
  private saving:Promise<void>=Promise.resolve();
  private ledger:{version:1;installationId:string;uploaded:string[];pending:string[];attempts:number;retryAt:number;local?:BackupChannelStatus;cloud?:BackupChannelStatus;schemaSignature?:string}|undefined;
  private ready(){
    return this.stateTask??= (async()=>{
      try{
        const raw=await readFile(join(this.dir,'backup-state.json'),'utf8');
        if(Buffer.byteLength(raw)>1024*1024)throw new Error('BACKUP_STATE_INVALID');
        const state=JSON.parse(raw);
        if(state.version!==1||!(/^[a-f0-9]{32}$/).test(state.installationId)||!Array.isArray(state.uploaded)||!Array.isArray(state.pending)||![...state.uploaded,...state.pending].every(n=>typeof n==='string'&&backupFilename.test(n))||!Number.isSafeInteger(state.attempts)||state.attempts<0||!Number.isSafeInteger(state.retryAt)||state.retryAt<0)throw new Error('BACKUP_STATE_INVALID');
        for(const channel of [state.local,state.cloud])if(channel!==undefined&&(!channel||!['pending','success','error','disabled'].includes(channel.state)||!Number.isSafeInteger(channel.lastSuccessAt)||channel.lastSuccessAt<0||typeof channel.filename!=='string'||(channel.filename!==''&&!backupFilename.test(channel.filename))||typeof channel.error!=='string'))throw new Error('BACKUP_STATE_INVALID');
        this.ledger=state;
      }catch(error){
        if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('BACKUP_STATE_INVALID');
        let pending:string[]=[];
        try{pending=(await readdir(join(this.dir,'backups'),{withFileTypes:true})).filter(e=>e.isFile()&&backupFilename.test(e.name)).map(e=>e.name);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
        this.ledger={version:1,installationId:randomBytes(16).toString('hex'),uploaded:[],pending,attempts:0,retryAt:0};
        await this.save();
      }
      // Only known backup staging files belong to this service. A completed archive is never temporary.
      try{for(const entry of await readdir(join(this.dir,'backups'),{withFileTypes:true}))if(entry.isFile()&&(/^(snapshot\.tmp\.sqlite(?:-wal|-shm)?|stream-panel-[\dTZ-]+-[a-f0-9]{8}\.spbk\.(tmp|verify\.tmp))$/.test(entry.name)))await rm(join(this.dir,'backups',entry.name),{force:true});}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      for(const entry of await readdir(this.dir,{withFileTypes:true}))if(entry.isFile()&&/^backup-state\.json\.[a-f0-9]{8}\.tmp$/.test(entry.name))await rm(join(this.dir,entry.name),{force:true});
      // Recover archives published just before a crash interrupted queue registration.
      let found:string[]=[];
      try{found=(await readdir(join(this.dir,'backups'),{withFileTypes:true})).filter(e=>e.isFile()&&backupFilename.test(e.name)).map(e=>e.name);}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const known=new Set([...this.ledger!.uploaded,...this.ledger!.pending]),unregistered=found.filter(name=>!known.has(name));
      if(unregistered.length){this.ledger!.pending.push(...unregistered);await this.save();}
      if(!this.options.url&&this.ledger!.pending.length){this.ledger!.pending=[];await this.save();}
      this.status.pendingUploads=this.ledger!.pending.length;this.status.nextRetryAt=this.ledger!.retryAt;
      if(this.ledger!.local){this.status.local=this.ledger!.local;this.status.filename=this.status.local.filename;this.status.lastSuccessAt=this.status.local.lastSuccessAt;}
      if(this.options.url&&this.ledger!.cloud)this.status.cloud=this.ledger!.cloud;
    })();
  }
  private save(){
    this.status.pendingUploads=this.ledger?.pending.length??0;this.status.nextRetryAt=this.ledger?.retryAt??0;
    const task=this.saving.catch(()=>{}).then(async()=>{
      const target=join(this.dir,'backup-state.json'),temporary=target+'.'+randomBytes(4).toString('hex')+'.tmp';
      const handle=await open(temporary,'wx',0o600);
      try{await handle.writeFile(JSON.stringify(this.ledger));await handle.sync();await handle.close();await rename(temporary,target);const directory=await open(this.dir,'r');try{await directory.sync();}finally{await directory.close();}}
      catch(error){await handle.close().catch(()=>{});await rm(temporary,{force:true});throw error;}
    });this.saving=task;return task;
  }
  async runIfDue(now=Date.now()){
    await this.ready();
    if(backupDue(this.status.local.lastSuccessAt,now))return this.run();
    const db=new Database(join(this.dir,'data.sqlite'),{readonly:true});
    let signature:string;
    try{signature=schemaSignature(db);}finally{db.close();}
    if(signature!==this.ledger!.schemaSignature)return this.run();
    return undefined;
  }
  async retryPending(now=Date.now(),force=false){
    await this.ready();
    if(!this.options.url||(!force&&this.ledger!.retryAt>now))return;
    if(this.uploadTask)return this.uploadTask;
    const task=(async()=>{
      try{
        const cloud=new CloudBackup({url:this.options.url!,serviceKeyFile:this.options.serviceKeyFile,bucket:this.options.bucket,prefix:'stream-panel/'+this.ledger!.installationId},this.request);
        for(const filename of [...this.ledger!.pending].sort().slice(0,4)){
          this.uploading=filename;try{await cloud.uploadFile(filename,join(this.dir,'backups',filename));}finally{this.uploading=undefined;}
          this.ledger!.pending=this.ledger!.pending.filter(n=>n!==filename);
          this.ledger!.uploaded=[...new Set([...this.ledger!.uploaded,filename])];
          this.ledger!.attempts=0;this.ledger!.retryAt=0;
          this.status.cloud={state:'success',lastSuccessAt:Date.now(),filename,error:''};
          this.ledger!.cloud=this.status.cloud;await this.save();
        }
        this.status.state=this.ledger!.pending.length?'pending':'uploaded';this.status.error='';
        await this.purgeLocal(now);
      }catch(error){
        const code=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'BACKUP_FAILED';
        this.ledger!.attempts++;this.ledger!.retryAt=now+Math.min(3600000,60000*2**Math.min(6,this.ledger!.attempts-1));
        this.status.state='partial';this.status.error=code;this.status.cloud={...this.status.cloud,state:'error',error:code};this.ledger!.cloud=this.status.cloud;await this.save();
      }
    })();this.uploadTask=task;
    try{await task;}finally{if(this.uploadTask===task)this.uploadTask=undefined;}
  }
  constructor(private dir: string, private options: { keyFile: string; url?: string; serviceKeyFile?: string; bucket?: string }, private request: typeof fetch = fetch, private readPersistedBackup: (path:string)=>Promise<Buffer> = readFile, private freeSpace:()=>Promise<number> = async()=>{const info=await statfs(this.dir);return info.bavail*info.bsize;}) {
    this.status.state = options.url ? "pending" : "local";
    this.status.local.state = "pending";
    this.status.cloud.state = options.url ? "pending" : "disabled";
  }
  run() {
    if (this.active) return this.active;
    this.active = this.perform().catch(error => {
      const code = /^[A-Z_]+$/.test(error.message) ? error.message : "BACKUP_FAILED";
      this.status.state = "error";
      this.status.error = code;
      this.status.local = { ...this.status.local, state: "error", error: code };
      throw new Error(code);
    }).finally(() => { this.active = undefined; });
    return this.active;
  }
  purgeLocal(now=Date.now()):Promise<void>{
    if(this.purgeTask)return this.purgeTask;
    const task=this.purgeLocalNow(now);this.purgeTask=task;
    return task.finally(()=>{if(this.purgeTask===task)this.purgeTask=undefined;});
  }
  private async purgeLocalNow(now:number):Promise<void>{
    await this.ready();
    const directory=join(this.dir,'backups');let entries;
    try{entries=await readdir(directory,{withFileTypes:true});}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    const names=entries.filter(e=>e.isFile()&&backupFilename.test(e.name)).map(e=>e.name);
    const ordered=[...names].sort().reverse(),minimum=new Set(ordered.slice(0,7));
    const keep=retainedBackups(names,now,this.status.local.filename);
    for(const name of minimum)keep.add(name);
    if(this.uploading)keep.add(this.uploading);
    // Nominal archive budget is 2 GiB; seven latest recovery points take priority.
    let bytes=0;const sizes=new Map<string,number>();
    for(const name of names){const size=(await lstat(join(directory,name))).size;sizes.set(name,size);if(keep.has(name))bytes+=size;}
    for(const name of [...ordered].reverse())if(bytes>2*1024**3&&keep.has(name)&&!minimum.has(name)&&name!==this.uploading){keep.delete(name);bytes-=sizes.get(name)!;}
    for(const name of names)if(!keep.has(name))await rm(join(directory,name),{force:true});
    this.ledger!.pending=this.options.url?this.ledger!.pending.filter(n=>!names.includes(n)||keep.has(n)):[];
    this.ledger!.uploaded=this.ledger!.uploaded.filter(n=>keep.has(n));await this.save();
  }
  async files() {
    await this.purgeLocal();
    const directory=resolve(this.dir,"backups");
    let entries;
    try {entries=await readdir(directory,{withFileTypes:true});}
    catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return {directory,files:[],local:this.status.local,cloud:this.status.cloud};throw error;}
    const files=[];
    for(const entry of entries.filter(e=>e.isFile()&&backupFilename.test(e.name)).sort((a,b)=>b.name.localeCompare(a.name))){
      try {
        const info=await lstat(join(directory,entry.name));
        if(info.isFile()&&info.size>=33&&info.size<=BACKUP_STREAM_MAX_SIZE)files.push({filename:entry.name,size:info.size,createdAt:info.mtimeMs});
      }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    }
    return {directory,files,local:this.status.local,cloud:this.status.cloud};
  }
  async file(filename:string):Promise<Buffer> {
    if(!backupFilename.test(filename))throw new Error("BACKUP_NOT_FOUND");
    try {
      const handle=await open(join(this.dir,"backups",filename),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try {
        const info=await handle.stat();
        if(!info.isFile()||info.size<33||info.size>maxSize)throw new Error("BACKUP_NOT_FOUND");
        const blob=await handle.readFile();
        if(blob.length>maxSize||!["SPBK1","SPBK2"].includes(blob.subarray(0,5).toString()))throw new Error("BACKUP_NOT_FOUND");
        return blob;
      }finally{await handle.close();}
    }catch(error){if(["ENOENT","ELOOP","ENOTDIR"].includes((error as NodeJS.ErrnoException).code??""))throw new Error("BACKUP_NOT_FOUND");throw error;}
  }
  async download(filename:string) {
    if(!backupFilename.test(filename))throw new Error("BACKUP_NOT_FOUND");
    try {
    const handle=await open(join(this.dir,"backups",filename),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const info=await handle.stat(),header=Buffer.alloc(5);
      if(!info.isFile()||info.size<33||info.size>BACKUP_STREAM_MAX_SIZE)throw new Error("BACKUP_NOT_FOUND");
      await handle.read(header,0,5,0);
      if(!["SPBK1","SPBK2"].includes(header.toString()))throw new Error("BACKUP_NOT_FOUND");
      return handle.createReadStream({start:0,autoClose:true});
    } catch(error) {await handle.close();throw error;}
    } catch(error) {
      if(["ENOENT","ELOOP","ENOTDIR"].includes((error as NodeJS.ErrnoException).code??""))throw new Error("BACKUP_NOT_FOUND");
      throw error;
    }
  }
  private async perform() {
    const directory = join(this.dir, "backups"); await mkdir(directory, {recursive:true,mode:0o700});
    await this.ready();
    await this.purgeLocal();
    if(this.ledger!.pending.length>=20)throw new Error("BACKUP_QUEUE_LIMIT");
    const encodedKey = (await readFile(this.options.keyFile, "utf8")).trim();
    if (!/^[a-fA-F0-9]{64}$/.test(encodedKey)) throw new Error("INVALID_BACKUP_KEY");
    const key = Buffer.from(encodedKey, "hex");
    const databaseSize=(await stat(join(this.dir,"data.sqlite"))).size;
    if (databaseSize > BACKUP_STREAM_MAX_SIZE) throw new Error("BACKUP_SIZE_LIMIT");
    let walSize=0;
    try {walSize=(await stat(join(this.dir,"data.sqlite-wal"))).size;}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    if(await this.freeSpace()<STORAGE_MIN_FREE_BYTES+3*(databaseSize+walSize))throw new Error("BACKUP_STORAGE_LIMIT");
    const snapshot = join(directory, "snapshot.tmp.sqlite");
    let pendingFile:string|undefined;
    try {
      const db = new Database(join(this.dir, "data.sqlite"), {readonly:true});
      try { await db.backup(snapshot); } finally { db.close(); }
      const check = new Database(snapshot, {readonly:true});
      let signature:string;
      try { validateSnapshot(check);signature=schemaSignature(check); } finally { check.close(); }
      const secrets: Record<string,unknown> = {};
      for (const profile of profiles) {
        try { secrets[profile] = JSON.parse(await readFile(join(this.dir,"profiles",profile,"secrets.json"), "utf8")); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      }
      const metadata = Buffer.from(JSON.stringify({version:1,profiles:secrets}));
      const snapshotSize = (await stat(snapshot)).size;
      if (metadata.length > 1024*1024 || metadata.length + 4 + snapshotSize > BACKUP_STREAM_MAX_SIZE) throw new Error("BACKUP_SIZE_LIMIT");
      const length = Buffer.alloc(4); length.writeUInt32BE(metadata.length);
      const filename = `stream-panel-${new Date().toISOString().replace(/[:.]/g,"-")}-${randomBytes(4).toString("hex")}.spbk`;
      const path = join(directory, filename);
      const temporary = path + ".tmp";
      const streaming = metadata.length + 4 + snapshotSize > 40*1024*1024;
      let blob:Buffer|undefined,payloadHash:string;
      if(streaming) {
        const source=async function*(){yield length;yield metadata;yield* createReadStream(snapshot);};
        payloadHash=await sealBackupFile(source(),temporary,key);
        pendingFile=temporary;
      } else {
      const payload = Buffer.concat([length, metadata, await readFile(snapshot)]);
      payloadHash = createHash("sha256").update(payload).digest("hex");
      blob = sealBackup(payload, key);
      if (blob.length > maxSize) throw new Error("BACKUP_SIZE_LIMIT");
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      pendingFile=temporary;
      try {
        await handle.writeFile(blob);
        await handle.sync();
      } catch (error) {
        await rm(temporary, {force:true});
        throw error;
      } finally { await handle.close(); }
      }
      await rename(temporary, path);
      pendingFile=undefined;
      const directoryHandle = await open(directory, constants.O_RDONLY);
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      try {
        let verifiedHash:string;
        if(streaming) {
          const verification=path+".verify.tmp";
          try {verifiedHash=await openBackupFile(path,verification,key);}
          finally {await rm(verification,{force:true});}
        } else {
          const persisted = await this.readPersistedBackup(path);
          verifiedHash=createHash("sha256").update(openBackup(persisted,key)).digest("hex");
        }
        if (verifiedHash !== payloadHash)
          throw new Error("BACKUP_LOCAL_VERIFY_FAILED");
      } catch {
        await rm(path, {force:true});
        throw new Error("BACKUP_LOCAL_VERIFY_FAILED");
      }

      const localSuccessAt = Date.now();
      this.status = {
        ...this.status,
        state: this.options.url ? "pending" : "local",
        lastSuccessAt: localSuccessAt,
        filename,
        error: "",
        local: { state: "success", lastSuccessAt: localSuccessAt, filename, error: "" },
      };
      if(this.options.url)this.ledger!.pending.push(filename);this.ledger!.local=this.status.local;this.ledger!.schemaSignature=signature;await this.save();
      if(!this.options.url){await this.purgeLocal();return {filename};}
      // Creating a snapshot explicitly retries pending uploads; the timer respects backoff.
      await this.retryPending(Date.now(),true);
      if(this.status.cloud.state==='error')return {filename,cloudError:this.status.cloud.error};
      this.status.lastSuccessAt=this.status.cloud.lastSuccessAt;
      return {filename};
    } finally {
      if(pendingFile)await rm(pendingFile,{force:true});
      for (const path of [snapshot, snapshot + "-wal", snapshot + "-shm"])
        await rm(path, {force:true});
    }
  }
  async stop() { await this.active?.catch(() => {}); await this.uploadTask?.catch(()=>{}); await this.saving.catch(()=>{}); }
}
export async function restoreBackup(blob: Buffer, key: Buffer, destination: string) {
  // Restore only into a new directory. Operator stops the service and selects it.
  await mkdir(destination, {mode:0o700});
  try {
    const payload = openBackup(blob, key), length = payload.readUInt32BE(0);
    const metadata = JSON.parse(payload.subarray(4,4+length).toString()) as {version:number;profiles:Record<string,unknown>};
    if (metadata.version !== 1) throw new Error("UNSUPPORTED_BACKUP");
    const database = join(destination,"data.sqlite");
    await writeFile(database, payload.subarray(4+length), {mode:0o600,flag:"wx"});
    const db = new Database(database, {readonly:true});
    try { validateSnapshot(db); } finally { db.close(); }
    for (const profile of profiles) if (metadata.profiles[profile]) {
      const dir = join(destination,"profiles",profile); await mkdir(dir,{recursive:true,mode:0o700});
      await writeFile(join(dir,"secrets.json"),JSON.stringify(metadata.profiles[profile]),{mode:0o600,flag:"wx"});
    }
    // A stolen old session must not regain access after a disaster restore.
    const sessions = new Database(database);
    try { sessions.exec("DELETE FROM sp_auth_sessions"); } finally { sessions.close(); }
  } catch (e) { await rm(destination,{recursive:true,force:true}); throw e; }
}

export async function restoreBackupFile(input:string,key:Buffer,destination:string) {
  const source=await open(input,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let format:string;
  try {
    const header=Buffer.alloc(5);await source.read(header,0,5,0);format=header.toString();
    if(format==="SPBK1") {
      if((await source.stat()).size>maxSize)throw new Error("BACKUP_SIZE_LIMIT");
      return await restoreBackup(await source.readFile(),key,destination);
    }
  } finally {await source.close();}
  if(format!=="SPBK2")throw new Error("BACKUP_INVALID");
  await mkdir(destination,{mode:0o700});
  try {
    const staging=join(destination,"payload.tmp");
    await openBackupFile(input,staging,key);
    const handle=await open(staging,"r");
    let metadata:{version:number;profiles:Record<string,unknown>},length:number;
    try {
      const size=(await handle.stat()).size,header=Buffer.alloc(4);
      if((await handle.read(header,0,4,0)).bytesRead!==4)throw new Error("BACKUP_INVALID");
      length=header.readUInt32BE();
      if(length>1024*1024||length>size-4)throw new Error("BACKUP_INVALID");
      const content=Buffer.alloc(length);
      if((await handle.read(content,0,length,4)).bytesRead!==length)throw new Error("BACKUP_INVALID");
      try {metadata=JSON.parse(content.toString());}catch{throw new Error("BACKUP_INVALID");}
      if(!metadata||metadata.version!==1||!metadata.profiles||typeof metadata.profiles!=="object")throw new Error("UNSUPPORTED_BACKUP");
    } finally {await handle.close();}
    const database=join(destination,"data.sqlite");
    await pipeline(createReadStream(staging,{start:4+length}),createWriteStream(database,{flags:"wx",mode:0o600}));
    const db=new Database(database,{readonly:true});
    try {validateSnapshot(db);}finally{db.close();}
    for(const profile of profiles)if(metadata.profiles[profile]) {
      const directory=join(destination,"profiles",profile);await mkdir(directory,{recursive:true,mode:0o700});
      await writeFile(join(directory,"secrets.json"),JSON.stringify(metadata.profiles[profile]),{mode:0o600,flag:"wx"});
    }
    const sessions=new Database(database);
    try {sessions.exec("DELETE FROM sp_auth_sessions");}finally{sessions.close();}
    await rm(staging);
  } catch(error) {await rm(destination,{recursive:true,force:true});throw error;}
}
