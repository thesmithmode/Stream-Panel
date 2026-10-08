import Database from "better-sqlite3";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile, readdir, rm, stat, rename } from "node:fs/promises";
import { join } from "node:path";
const magic = Buffer.from("SPBK1");
const maxSize = 48 * 1024 * 1024;
const profiles = ["ruslan", "gulnaz"] as const;
export function sealBackup(payload: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error("INVALID_BACKUP_KEY");
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const compressed = gzipSync(payload);
  return Buffer.concat([magic, iv, cipher.update(compressed), cipher.final(), cipher.getAuthTag()]);
}
export function openBackup(blob: Buffer, key: Buffer): Buffer {
  if (key.length !== 32 || blob.length < 33 || !blob.subarray(0, 5).equals(magic)) throw new Error("INVALID_BACKUP");
  const cipher = createDecipheriv("aes-256-gcm", key, blob.subarray(5, 17));
  cipher.setAuthTag(blob.subarray(-16));
  return gunzipSync(Buffer.concat([cipher.update(blob.subarray(17, -16)), cipher.final()]), { maxOutputLength: 64 * 1024 * 1024 });
}
export class BackupService {
  status = { state: "disabled", lastSuccessAt: 0, error: "" };
  private active: Promise<{filename:string}> | undefined;
  constructor(private dir: string, private options: { keyFile: string; url?: string; serviceKeyFile?: string; bucket?: string }, private request: typeof fetch = fetch) {
    this.status.state = options.url ? "pending" : "local";
  }
  run() {
    if (this.active) return this.active;
    this.active = this.perform().catch(error => { this.status.state = "error"; this.status.error = /^[A-Z_]+$/.test(error.message) ? error.message : "BACKUP_FAILED"; throw new Error(this.status.error); }).finally(() => { this.active = undefined; });
    return this.active;
  }
  private async perform() {
    const directory = join(this.dir, "backups"); await mkdir(directory, {recursive:true,mode:0o700});
    const encodedKey = (await readFile(this.options.keyFile, "utf8")).trim();
    if (!/^[a-fA-F0-9]{64}$/.test(encodedKey)) throw new Error("INVALID_BACKUP_KEY");
    const key = Buffer.from(encodedKey, "hex");
    if ((await stat(join(this.dir, "data.sqlite"))).size > 40 * 1024 * 1024) throw new Error("BACKUP_SIZE_LIMIT");
    const snapshot = join(directory, "snapshot.tmp.sqlite");
    try {
      const db = new Database(join(this.dir, "data.sqlite"), {readonly:true});
      try { await db.backup(snapshot); } finally { db.close(); }
      const check = new Database(snapshot, {readonly:true});
      try { if (check.pragma("integrity_check", {simple:true}) !== "ok") throw new Error("BACKUP_INTEGRITY_FAILED"); } finally { check.close(); }
      const secrets: Record<string,unknown> = {};
      for (const profile of profiles) {
        try { secrets[profile] = JSON.parse(await readFile(join(this.dir,"profiles",profile,"secrets.json"), "utf8")); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      }
      const metadata = Buffer.from(JSON.stringify({version:1,profiles:secrets}));
      const length = Buffer.alloc(4); length.writeUInt32BE(metadata.length);
      const blob = sealBackup(Buffer.concat([length, metadata, await readFile(snapshot)]), key);
      if (blob.length > maxSize) throw new Error("BACKUP_SIZE_LIMIT");
      const filename = `stream-panel-${new Date().toISOString().replace(/[:.]/g,"-")}-${randomBytes(4).toString("hex")}.spbk`;
      const path = join(directory, filename);
      await writeFile(path + ".tmp", blob, {mode:0o600}); await rename(path + ".tmp", path);
      const owned = (await readdir(directory)).filter(f => /^stream-panel-[\dTZ-]+-[a-f0-9]{8}\.spbk$/.test(f)).sort().reverse();
      for (const old of owned.slice(3)) await rm(join(directory,old));
      if (this.options.url) await this.upload(filename, blob);
      this.status = { state: this.options.url ? "uploaded" : "local", lastSuccessAt: Date.now(), error:"" };
      return {filename};
    } finally { await rm(snapshot, {force:true}); }
  }
  private async upload(filename: string, blob: Buffer) {
    const url = new URL(this.options.url!);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".supabase.co") || url.origin !== this.options.url || !this.options.serviceKeyFile) throw new Error("INVALID_BACKUP_REMOTE");
    const bucket = this.options.bucket ?? "stream-panel-backups";
    if (!/^[a-z0-9-]{1,63}$/.test(bucket)) throw new Error("INVALID_BACKUP_BUCKET");
    const secret = (await readFile(this.options.serviceKeyFile, "utf8")).trim();
    if (!secret) throw new Error("MISSING_BACKUP_SERVICE_KEY");
    const call = async (path: string, method="GET", body?: BodyInit, contentType="application/json") => {
      const response = await this.request(`${url.origin}/storage/v1/${path}`, {method, headers:{Authorization:`Bearer ${secret}`, apikey:secret, "Content-Type":contentType}, ...(body === undefined ? {} : {body}), signal:AbortSignal.timeout(60000)});
      if (!response.ok) throw new Error("BACKUP_UPLOAD_FAILED");
      return response;
    };
    const info = await (await call(`bucket/${bucket}`)).json() as {public?:boolean};
    if (info.public !== false) throw new Error("BACKUP_BUCKET_MUST_BE_PRIVATE");
    await call(`object/${bucket}/stream-panel/${filename}`, "POST", new Uint8Array(blob), "application/octet-stream");
    const listed = await (await call(`object/list/${bucket}`, "POST", JSON.stringify({prefix:"stream-panel",limit:1000,offset:0,sortBy:{column:"name",order:"desc"}}))).json() as {name:string}[];
    if (!Array.isArray(listed)) throw new Error("BACKUP_INVALID_LIST");
    const owned = listed.map(x => x.name).filter(x => /^stream-panel-[\dTZ-]+-[a-f0-9]{8}\.spbk$/.test(x)).sort().reverse();
    if (!owned.includes(filename)) throw new Error("BACKUP_UPLOAD_NOT_VERIFIED");
    const remove = owned.slice(3).map(name => `stream-panel/${name}`);
    if (remove.length) await call(`object/${bucket}`,"DELETE",JSON.stringify({prefixes:remove}));
  }
  async stop() { await this.active?.catch(() => {}); }
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
    try { if (db.pragma("integrity_check",{simple:true}) !== "ok" || (db.pragma("foreign_key_check") as unknown[]).length) throw new Error("BACKUP_INTEGRITY_FAILED"); } finally { db.close(); }
    for (const profile of profiles) if (metadata.profiles[profile]) {
      const dir = join(destination,"profiles",profile); await mkdir(dir,{recursive:true,mode:0o700});
      await writeFile(join(dir,"secrets.json"),JSON.stringify(metadata.profiles[profile]),{mode:0o600,flag:"wx"});
    }
  } catch (e) { await rm(destination,{recursive:true,force:true}); throw e; }
}
