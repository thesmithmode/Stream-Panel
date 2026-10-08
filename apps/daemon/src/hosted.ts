import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import staticFiles from "@fastify/static";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { profiles, type Profile } from "./profiles.js";
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
  const activeProfileFile = join(dir, "active-profile.json");
  let activeProfile: Profile = "ruslan";
  try {
    const saved = JSON.parse(await readFile(activeProfileFile, "utf8")) as {profile?: unknown};
    if (typeof saved.profile !== "string" || !profiles.includes(saved.profile as Profile)) throw new Error("INVALID_ACTIVE_PROFILE");
    activeProfile = saved.profile as Profile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const runtimes = new Map<Profile, Awaited<ReturnType<typeof createApplication>>>();
  const app = Fastify({ logger: false, bodyLimit: 32768, trustProxy: ["127.0.0.1", "::1"],
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  const queues = new Map<Profile, { tail: Promise<void>; waiting: number }>();
  try {
    for (const profile of profiles) {
      const runtime = await createApplication(join(dir, "profiles", profile), 47831, connect, {}, {
        databasePath: join(dir, "data.sqlite"), profile, origin: publicOrigin, staticFiles: false,
      });
      await runtime.app.ready();
      runtimes.set(profile, runtime);
    }
  } catch (error) {
    await Promise.all([...runtimes.values()].map((r) => r.app.close()));
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
    reply.code(e.statusCode && e.statusCode < 500 ? e.statusCode : 500)
      .send({ error: e.statusCode && e.statusCode < 500 ? "INVALID_REQUEST" : "REQUEST_FAILED" });
  });
  app.get("/api/v1/profile", async () => ({ profile: activeProfile }));
  app.post("/api/v1/profile", { schema: { body: {
    type: "object", additionalProperties: false, required: ["profile"],
    properties: { profile: { type: "string", enum: [...profiles] } },
  } } }, async (request) => {
    const next = (request.body as { profile: Profile }).profile;
    if (next !== activeProfile) {
      const temporary = `${activeProfileFile}.${randomBytes(8).toString("hex")}.tmp`;
      await writeFile(temporary, JSON.stringify({ profile: next }), { mode: 0o600, flag: "wx" });
      await rename(temporary, activeProfileFile);
      activeProfile = next;
    }
    return { profile: activeProfile };
  });
  app.get("/healthz", async (_request, reply) => {
    try {
      await Promise.all([...runtimes.values()].map((r) => r.db.call("sessions")));
      return { ok: true, release: process.env.STREAM_PANEL_RELEASE ?? "development" };
    } catch { return reply.code(503).send({ ok: false }); }
  });
  const forward = async (request: FastifyRequest, reply: FastifyReply) => {
    const profile = activeProfile;
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
      const headers = { ...request.headers };
      delete headers["content-length"];
      const result = await runtime.app.inject({ method: request.method as "GET" | "POST" | "HEAD" | "PUT" | "DELETE" | "PATCH" | "OPTIONS", url: request.url, headers,
        ...(request.body === undefined ? {} : { payload: JSON.stringify(request.body) }) });
      const responseHeaders = { ...result.headers };
      delete responseHeaders["content-length"];
      if (request.url.split("?")[0] === "/api/v1/status" && result.statusCode === 200) {
        const status = result.json();
        status.backup = backup?.status ?? {state:"disabled"};
        status.profile = profile;
        reply.code(result.statusCode).headers(responseHeaders).send(JSON.stringify(status));
        return;
      }
      reply.code(result.statusCode).headers(responseHeaders).send(result.body);
    } finally { release(); if (queue) queue.waiting--; }
  };
  app.post("/api/v1/backup", async (_request, reply) => {
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
  });
  return { app, runtimes, backup, get activeProfile() { return activeProfile; } };
}
