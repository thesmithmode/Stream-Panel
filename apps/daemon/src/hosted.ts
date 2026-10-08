import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountStore, profiles, type Profile } from "./auth.js";
import { BackupService } from "./backup.js";
import { createApplication } from "./server.js";

export async function createHostedApplication(dir: string, publicOrigin: string, connect = true, backupOptions?: ConstructorParameters<typeof BackupService>[1]) {
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin || origin.username || origin.password ||
    (origin.protocol !== "https:" && !(origin.protocol === "http:" && origin.hostname === "127.0.0.1")))
    throw new Error("INVALID_PUBLIC_ORIGIN");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const backup = backupOptions ? new BackupService(dir, backupOptions) : undefined;
  let lastBackupRequest = 0;
  const accounts = new AccountStore(join(dir, "data.sqlite"));
  const runtimes = new Map<Profile, Awaited<ReturnType<typeof createApplication>>>();
  const app = Fastify({ logger: false, bodyLimit: 32768, trustProxy: ["127.0.0.1", "::1"],
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  await app.register(cookie);
  // Provider configuration changes for one profile are serialized. Different
  // profiles can act concurrently; SQLite worker queues serialize DB writes.
  const queues = new Map<Profile, { tail: Promise<void>; waiting: number }>();
  try {
    for (const profile of profiles) {
      const runtime = await createApplication(join(dir, "profiles", profile), 47831, connect, {}, {
        databasePath: join(dir, "data.sqlite"), profile, origin: publicOrigin, staticFiles: false,
        session: (request) => {
          const session = accounts.session(request.headers.cookie);
          return session?.profile === profile ? { csrf: session.csrf, expires: Number.MAX_SAFE_INTEGER } : null;
        },
      });
      await runtime.app.ready();
      runtimes.set(profile, runtime);
    }
  } catch (error) {
    await Promise.all([...runtimes.values()].map((r) => r.app.close()));
    accounts.close();
    throw error;
  }
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (request.headers.host !== origin.host) return reply.code(403).send({ error: "INVALID_HOST" });
    if (request.url.startsWith("/api/") && existsSync(join(dir, "deploying")))
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
    return { csrf: result.csrf, user: result.user };
  });
  app.get("/api/v1/auth/me", async (request, reply) => {
    const user = accounts.session(request.headers.cookie);
    if (!user) return reply.code(401).send({ error: "LOGIN_REQUIRED" });
    return { csrf: user.csrf, user: { profile: user.profile, username: user.username, displayName: user.displayName } };
  });
  app.post("/api/v1/auth/logout", async (request, reply) => {
    const user = accounts.session(request.headers.cookie);
    if (!user) return reply.code(401).send({ error: "LOGIN_REQUIRED" });
    if (!accounts.validCsrf(user, request.headers["x-csrf-token"])) return reply.code(403).send({ error: "CSRF_REQUIRED" });
    accounts.revoke(user);
    reply.clearCookie("sp_session", { path: "/", secure: origin.protocol === "https:", httpOnly: true, sameSite: "lax" });
    return { ok: true };
  });
  app.post("/api/v1/auth/password", { schema: { body: {
    type: "object", additionalProperties: false, required: ["currentPassword", "newPassword", "confirmation"],
    properties: { currentPassword: {type:"string",minLength:1,maxLength:256}, newPassword: {type:"string",minLength:14,maxLength:256}, confirmation: {type:"string",minLength:14,maxLength:256} },
  } } }, async (request, reply) => {
    const user = accounts.session(request.headers.cookie);
    if (!user) return reply.code(401).send({error:"LOGIN_REQUIRED"});
    if (!accounts.validCsrf(user, request.headers["x-csrf-token"])) return reply.code(403).send({error:"CSRF_REQUIRED"});
    const body = request.body as {currentPassword:string;newPassword:string;confirmation:string};
    if (body.newPassword !== body.confirmation) return reply.code(400).send({error:"PASSWORD_MISMATCH"});
    const verified = await accounts.login(user.username, body.currentPassword, request.ip);
    if (!verified) return reply.code(401).send({error:"INVALID_CURRENT_PASSWORD"});
    accounts.logout(verified.token);
    await backup?.run();
    await accounts.resetPassword(user.profile, body.newPassword);
    reply.clearCookie("sp_session", {path:"/", secure:origin.protocol === "https:", httpOnly:true, sameSite:"lax"});
    return {ok:true};
  });
  app.get("/healthz", async (_request, reply) => {
    try {
      await Promise.all([...runtimes.values()].map((r) => r.db.call("sessions")));
      return { ok: true, release: process.env.STREAM_PANEL_RELEASE ?? "development" };
    } catch { return reply.code(503).send({ ok: false }); }
  });
  const forward = async (request: FastifyRequest, reply: FastifyReply) => {
    const user = accounts.session(request.headers.cookie);
    if (!user) return reply.code(401).send({ error: "LOGIN_REQUIRED" });
    const runtime = runtimes.get(user.profile)!;
    let release = () => {};
    let queue: { tail: Promise<void>; waiting: number } | undefined;
    if (request.method !== "GET" && request.method !== "HEAD" || request.url.startsWith("/oauth/")) {
      queue = queues.get(user.profile) ?? { tail: Promise.resolve(), waiting: 0 };
      if (queue.waiting >= 100) return reply.code(503).send({ error: "QUEUE_OVERFLOW" });
      queues.set(user.profile, queue);
      queue.waiting++;
      const previous = queue.tail;
      queue.tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
    }
    try {
      // Recheck after waiting: logout can revoke a queued request's session.
      if (!accounts.session(request.headers.cookie)) return reply.code(401).send({ error: "LOGIN_REQUIRED" });
      const headers = { ...request.headers };
      delete headers["content-length"];
      const result = await runtime.app.inject({ method: request.method as "GET" | "POST" | "HEAD" | "PUT" | "DELETE" | "PATCH" | "OPTIONS", url: request.url, headers,
        ...(request.body === undefined ? {} : { payload: JSON.stringify(request.body) }) });
      const responseHeaders = { ...result.headers };
      delete responseHeaders["content-length"];
      const payload = request.url.split("?")[0] === "/api/v1/status" && result.statusCode === 200
        ? JSON.stringify({ ...result.json(), backup: backup?.status ?? {state:"disabled"}, user: { profile: user.profile, username: user.username, displayName: user.displayName } }) : result.body;
      reply.code(result.statusCode).headers(responseHeaders).send(payload);
    } finally { release(); if (queue) queue.waiting--; }
  };
  app.post("/api/v1/backup", async (request, reply) => {
    const user = accounts.session(request.headers.cookie);
    if (!user) return reply.code(401).send({error:"LOGIN_REQUIRED"});
    if (!accounts.validCsrf(user,request.headers["x-csrf-token"])) return reply.code(403).send({error:"CSRF_REQUIRED"});
    if (!backup) return reply.code(503).send({error:"BACKUP_NOT_CONFIGURED"});
    if (Date.now() - lastBackupRequest < 600000) return reply.code(429).send({error:"BACKUP_RATE_LIMIT"});
    lastBackupRequest = Date.now();
    return backup.run();
  });
  app.all("/api/v1/*", forward);
  app.get("/oauth/:provider/callback", forward);
  await app.register(staticFiles, { root: join(dirname(fileURLToPath(import.meta.url)), "../../../../apps/web/dist"), prefix: "/" });
  app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") || request.url.startsWith("/oauth/")
    ? reply.code(404).send({ error: "NOT_FOUND" }) : reply.sendFile("index.html"));
  app.addHook("onClose", async () => {
    await backup?.stop();
    await Promise.all([...runtimes.values()].map((r) => r.app.close()));
    accounts.close();
  });
  return { app, accounts, runtimes, backup };
}
