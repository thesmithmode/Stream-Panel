import {registerAnalyticsCompression} from './analytics-compression.js';
import {prepareChatStorage} from "./chat-cleanup.js";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import { BACKUP_STREAM_MAX_SIZE } from "./backup-stream.js";
import { stageRestore, commitRestore, receiveRestore } from "./restore-service.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountStore, profiles, canAccessProfile, publicUser, type Profile } from "./auth.js";
import { BackupService } from "./backup.js";
import { createApplication } from "./server.js";
import {
  DEFAULT_HOSTED_NETWORK_CONFIG,
  type HostedNetworkConfig,
} from "./hosted-network.js";

export async function createHostedApplication(
  dir: string,
  publicOrigin: string,
  connect = true,
  backupOptions?: ConstructorParameters<typeof BackupService>[1],
  network: HostedNetworkConfig = DEFAULT_HOSTED_NETWORK_CONFIG,
  serveStatic=true,
  onRestore?:()=>void,
) {
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin || origin.username || origin.password ||
    (origin.protocol !== "https:" && !(origin.protocol === "http:" && origin.hostname === "127.0.0.1")))
    throw new Error("INVALID_PUBLIC_ORIGIN");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const backup = backupOptions ? new BackupService(dir, backupOptions) : undefined;
  let lastBackupRequest = 0;
  let restoreBusy = false;
  console.log("Storage maintenance check started");
  const maintenance=await prepareChatStorage(join(dir,"data.sqlite"));
  console.log("Storage maintenance check completed"+(maintenance?": "+JSON.stringify(maintenance):""));
  const accounts = new AccountStore(join(dir, "data.sqlite"));
  const selectedProfile = (request: FastifyRequest, fallback: Profile): Profile =>
    request.headers["x-stream-panel-profile"] as Profile | undefined ?? fallback;
  const oauthBindings = new Map<string, { profile: Profile; tokenHash: string; provider: string; expires: number }>();
  const runtimes = new Map<Profile, Awaited<ReturnType<typeof createApplication>>>();
  const app = Fastify({ logger: false, bodyLimit: 32768, trustProxy: [...network.trustedProxies],
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  registerAnalyticsCompression(app);
  await app.register(cookie);
  app.addContentTypeParser('application/octet-stream', (_request,payload,done)=>done(null,payload));
  // Provider configuration changes for one profile are serialized. Different
  // profiles can act concurrently; SQLite worker queues serialize DB writes.
  const queues = new Map<Profile, { tail: Promise<void>; waiting: number }>();
  try {
    for (const profile of profiles) {
      const runtime = await createApplication(join(dir, "profiles", profile), 47831, connect, {}, {
        databasePath: join(dir, "data.sqlite"), profile, origin: publicOrigin, staticFiles: false,
        canViewCredentials: request => accounts.session(request.headers.cookie)?.profile === "ruslan",
        session: (request) => {
          const session = accounts.session(request.headers.cookie);
          return session && canAccessProfile(session.profile, profile) && selectedProfile(request, session.profile) === profile ? { csrf: session.csrf, expires: Number.MAX_SAFE_INTEGER } : null;
        },
      });
      if(backup)runtime.db.setStorageCleanup(()=>backup.purgeLocal());
      await runtime.app.ready();
      runtimes.set(profile, runtime);
    }
  } catch (error) {
    await Promise.all([...runtimes.values()].map((r) => r.app.close()));
    accounts.close();
    throw error;
  }
  app.addHook("onRequest", async (request, reply) => {
    if(request.url.split('?')[0]!.endsWith('.map'))return reply.code(404).send({error:'NOT_FOUND'});
    reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (request.headers.host !== origin.host) return reply.code(403).send({ error: "INVALID_HOST" });
    const requestedProfile = request.headers["x-stream-panel-profile"];
    if (requestedProfile !== undefined && (typeof requestedProfile !== "string" || !profiles.includes(requestedProfile as Profile)))
      return reply.code(400).send({ error: "INVALID_PROFILE" });
    const account = accounts.session(request.headers.cookie);
    if (account && !request.url.split("?")[0]!.startsWith("/api/v1/auth/") && requestedProfile !== undefined && !canAccessProfile(account.profile, requestedProfile as Profile))
      return reply.code(403).send({error:"PROFILE_FORBIDDEN"});
    if (request.url.startsWith("/api/") && ["deploying", "initializing", "restoring"].some(marker=>existsSync(join(dir,marker))))
      return reply.header("Retry-After", "10").code(503).send({ error: "SERVER_UPDATING" });
    if (!["GET", "HEAD"].includes(request.method) && request.headers.origin !== publicOrigin)
      return reply.code(403).send({ error: "INVALID_ORIGIN" });
  });
  app.setErrorHandler((error, _request, reply) => {
    const e = error as Error & { statusCode?: number };
    const limit = /^(LOGIN_RATE_LIMIT|AUTH_BUSY|TOO_MANY_SESSIONS)$/.test(e.message);
    if (limit) reply.header("Retry-After", "900");
    reply.code(limit ? 429 : e.statusCode && e.statusCode < 500 ? e.statusCode : 500)
      .send({ error: limit ? "LOGIN_RATE_LIMIT" : e.statusCode && e.statusCode < 500 ? "INVALID_REQUEST" : "REQUEST_FAILED" });
  });
  app.post("/api/v1/auth/login", { schema: { body: {
    type: "object", additionalProperties: false, required: ["username", "password"],
    properties: { username: { type: "string", minLength: 1, maxLength: 32 }, password: { type: "string", minLength: 1, maxLength: 256 } },
  } } }, async (request, reply) => {
    const body = request.body as { username: string; password: string };
    const result = await accounts.login(body.username, body.password, request.ip);
    if (!result) return reply.code(401).send({ error: "INVALID_LOGIN" });
    reply.setCookie("sp_session", result.token, { httpOnly: true, secure: origin.protocol === "https:", sameSite: "lax", path: "/", maxAge: 86400 });
    return { csrf: result.csrf, user: publicUser(result.user) };
  });
  app.get("/api/v1/auth/me", async (request, reply) => {
    const user = accounts.session(request.headers.cookie);
    if (!user) return reply.code(401).send({ error: "LOGIN_REQUIRED" });
    return { csrf: user.csrf, user: publicUser(user) };
  });
  app.post("/api/v1/auth/logout", async (request, reply) => {
    const user = accounts.session(request.headers.cookie);
    if (!user) return reply.code(401).send({ error: "LOGIN_REQUIRED" });
    if (!accounts.validCsrf(user, request.headers["x-csrf-token"])) return reply.code(403).send({ error: "CSRF_REQUIRED" });
    accounts.revoke(user);
    reply.clearCookie("sp_session", { path: "/", secure: origin.protocol === "https:", httpOnly: true, sameSite: "lax" });
    return { ok: true };
  });
  app.get("/healthz", async (_request, reply) => {
    try {
      await Promise.all([...runtimes.values()].map((r) => r.db.call("activeLogicalStream")));
      return { ok: true, release: process.env.STREAM_PANEL_RELEASE ?? "development" };
    } catch { return reply.code(503).send({ ok: false }); }
  });
  const forward = async (request: FastifyRequest, reply: FastifyReply) => {
    const user = accounts.session(request.headers.cookie);
    if (!user) return reply.code(401).send({ error: "LOGIN_REQUIRED" });
    let profile = selectedProfile(request, user.profile);
    const callback = new URL(request.url, publicOrigin);
    if (callback.pathname.startsWith("/oauth/")) {
      if (!/^\/oauth\/(youtube|donationalerts)\/callback$/.test(callback.pathname))
        return reply.code(404).send({ error: "NOT_FOUND" });
      const state = callback.searchParams.get("state") ?? "";
      const binding = oauthBindings.get(state);
      if (!binding || binding.expires <= Date.now() || callback.pathname !== `/oauth/${binding.provider}/callback`)
        return reply.code(400).send({ error: "INVALID_OAUTH_STATE" });
      if (binding.tokenHash !== user.tokenHash) return reply.code(403).send({ error: "INVALID_OAUTH_SESSION" });
      profile = binding.profile;
      if (!canAccessProfile(user.profile, profile)) return reply.code(403).send({error:"PROFILE_FORBIDDEN"});
      oauthBindings.delete(state);
    }
    if (!canAccessProfile(user.profile, profile)) return reply.code(403).send({error:"PROFILE_FORBIDDEN"});
    const runtime = runtimes.get(profile)!;
    let release = () => {};
    let queue: { tail: Promise<void>; waiting: number } | undefined;
    if (request.method !== "GET" && request.method !== "HEAD" || request.url.startsWith("/oauth/")) {
      queue = queues.get(profile) ?? { tail: Promise.resolve(), waiting: 0 };
      if (queue.waiting >= 100) return reply.code(503).send({ error: "QUEUE_OVERFLOW" });
      queues.set(profile, queue);
      queue.waiting++;
      const previous = queue.tail;
      queue.tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
    }
    try {
      // Recheck after waiting: logout can revoke a queued request's session.
      const currentUser = accounts.session(request.headers.cookie);
      if (!currentUser) return reply.code(401).send({ error: "LOGIN_REQUIRED" });
      if (!canAccessProfile(currentUser.profile, profile)) return reply.code(403).send({error:"PROFILE_FORBIDDEN"});
      const headers = { ...request.headers };
      headers["x-stream-panel-profile"] = profile;
      delete headers["content-length"];
      const result = await runtime.app.inject({ method: request.method as "GET" | "POST" | "HEAD" | "PUT" | "DELETE" | "PATCH" | "OPTIONS", url: request.url, headers,
        ...(request.body === undefined ? {} : { payload: JSON.stringify(request.body) }) });
      if (result.statusCode === 200 && /^\/api\/v1\/(youtube|donationalerts)\/connect$/.test(callback.pathname)) {
        const url = result.json().url;
        if (typeof url === "string") {
          const state = new URL(url).searchParams.get("state");
          for (const [key, value] of oauthBindings) if (value.expires <= Date.now()) oauthBindings.delete(key);
          if (state) oauthBindings.set(state, { profile, tokenHash: user.tokenHash, provider: callback.pathname.split("/")[3]!, expires: Date.now() + 600000 });
        }
      }
      const responseHeaders = { ...result.headers };
      delete responseHeaders["content-length"];
      const payload = request.url.split("?")[0] === "/api/v1/status" && result.statusCode === 200
        ? JSON.stringify({ ...result.json(), ...(user.profile === "ruslan" ? {backup: {...(backup?.status ?? {state:"disabled"}),restoreAvailable:!!backup&&!!onRestore}} : {}), user: publicUser(user, profile) }) : result.body;
      reply.code(result.statusCode).headers(responseHeaders).send(payload);
    } finally { release(); if (queue) queue.waiting--; }
  };
  const canReadBackups=(request:FastifyRequest,reply:FastifyReply)=>{
    const account=accounts.session(request.headers.cookie);
    if(!account){reply.code(401).send({error:"LOGIN_REQUIRED"});return false;}
    if(account.profile!=="ruslan"){reply.code(403).send({error:"BACKUP_FORBIDDEN"});return false;}
    if(request.headers["sec-fetch-site"]==="cross-site" || (request.headers.origin!==undefined&&request.headers.origin!==publicOrigin)){reply.code(403).send({error:"INVALID_ORIGIN"});return false;}
    if(!backup){reply.code(503).send({error:"BACKUP_NOT_CONFIGURED"});return false;}
    return true;
  };
  const canWriteBackups=async(request:FastifyRequest,reply:FastifyReply)=>{
    if(!canReadBackups(request,reply))return;
    const user=accounts.session(request.headers.cookie)!;
    if(!accounts.validCsrf(user,request.headers['x-csrf-token']))return reply.code(403).send({error:'CSRF_REQUIRED'});
  };
  app.post('/api/v1/backup/key',{onRequest:canWriteBackups},async()=>{
    const key=(await readFile(backupOptions!.keyFile,'utf8')).trim();
    if(!/^[a-f0-9]{64}$/i.test(key))throw new Error('INVALID_BACKUP_KEY');
    return {key};
  });
  app.post('/api/v1/backups/restore',{onRequest:canWriteBackups},async(request,reply)=>{
    if(!onRestore)return reply.code(503).send({error:'RESTORE_NOT_AVAILABLE'});
    if(restoreBusy||existsSync(join(dir,'restore-pending')))return reply.code(409).send({error:'RESTORE_PENDING'});
    if(Number(request.headers['content-length'])>BACKUP_STREAM_MAX_SIZE)return reply.code(413).send({error:'BACKUP_SIZE_LIMIT'});
    const supplied=request.headers['x-backup-key'];
    const key=supplied??(await readFile(backupOptions!.keyFile,'utf8')).trim();
    if(typeof key!=='string'||!/^[a-f0-9]{64}$/i.test(key))return reply.code(400).send({error:'INVALID_BACKUP_KEY'});
    if(!(request.body instanceof Readable))return reply.code(400).send({error:'BACKUP_INVALID'});
    restoreBusy=true;
    let temporary:string|undefined,prepared=false,failure:string|undefined;
    try{
      temporary=await mkdtemp(join(dir,'restore-upload-'));
      const input=join(temporary,'input.spbk'),stage=join(temporary,'staged');
      await receiveRestore(request.body,input);
      await stageRestore(input,Buffer.from(key,'hex'),stage);
      await Promise.all([...runtimes.values()].map(runtime=>runtime.configuration.save()));
      await backup!.run(); // A local safety snapshot is required before replacement.
      await commitRestore(dir,stage);
      prepared=true;
    }catch(error){
      const code=(error as Error).message;
      failure=code==='BACKUP_SIZE_LIMIT'?code:'BACKUP_INVALID';
    }finally{
      if(temporary)await rm(temporary,{recursive:true,force:true}).catch(()=>{});
      if(!prepared)restoreBusy=false;
    }
    if(failure)return reply.code(failure==='BACKUP_SIZE_LIMIT'?413:400).send({error:failure});
    reply.code(202).send({ok:true,restartRequired:true});
    onRestore(); // The production callback allows the response a shutdown grace period.
    return reply;
  });
  app.get("/api/v1/backups",async(request,reply)=>{
    if(!canReadBackups(request,reply))return;
    return backup!.files();
  });
  app.get("/api/v1/backups/:filename",async(request,reply)=>{
    if(!canReadBackups(request,reply))return;
    const filename=(request.params as {filename:string}).filename;
    try {
      const blob=await backup!.download(filename);
      return reply.type("application/octet-stream").header("Content-Disposition",`attachment; filename="${filename}"`).header("Content-Length",blob.size).send(blob);
    }catch(error){if((error as Error).message==="BACKUP_NOT_FOUND")return reply.code(404).send({error:"BACKUP_NOT_FOUND"});throw error;}
  });
  app.post("/api/v1/backup", async (request, reply) => {
    const user = accounts.session(request.headers.cookie);
    if (!user) return reply.code(401).send({error:"LOGIN_REQUIRED"});
    if (user.profile !== "ruslan") return reply.code(403).send({error:"BACKUP_FORBIDDEN"});
    if (!accounts.validCsrf(user,request.headers["x-csrf-token"])) return reply.code(403).send({error:"CSRF_REQUIRED"});
    if (!backup) return reply.code(503).send({error:"BACKUP_NOT_CONFIGURED"});
    if (Date.now() - lastBackupRequest < 600000) return reply.code(429).send({error:"BACKUP_RATE_LIMIT"});
    lastBackupRequest = Date.now();
    return backup.run({waitForCloud:false});
  });
  app.all("/api/v1/*", forward);
  app.get("/oauth/:provider/callback", forward);
  if(serveStatic){
    await app.register(staticFiles, { root: join(dirname(fileURLToPath(import.meta.url)), "../../../../apps/web/dist"), prefix: "/" });
    app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") || request.url.startsWith("/oauth/")
      ? reply.code(404).send({ error: "NOT_FOUND" }) : reply.sendFile("index.html"));
  }
  app.addHook("onClose", async () => {
    await backup?.stop();
    await Promise.all([...runtimes.values()].map((r) => r.app.close()));
    accounts.close();
  });
  return { app, accounts, runtimes, backup };
}
