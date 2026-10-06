import Fastify from "fastify";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StoreClient } from "./db.js";
import { Configuration } from "./config.js";
import { TwitchConnection, object, string } from "./twitch.js";
import { DonationAlertsConnection } from "./donationalerts.js";

export async function createApplication(
  dir: string,
  port: number,
  connect = true,
) {
  const configuration = new Configuration(dir);
  await configuration.load();
  const db = new StoreClient(join(dir, "data.sqlite"));
  await db.ready;
  const twitch = new TwitchConnection(configuration, db),
    da = new DonationAlertsConnection(configuration, db);
  const app = Fastify({ logger: false, bodyLimit: 32768 });
  await app.register(cookie);
  app.setErrorHandler((error, request, reply) => {
    const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
    const safe = /^[A-Z0-9_]+$/.test(code) ? code : "REQUEST_FAILED";
    reply
      .code(
        /CONFLICT|ALREADY_OPEN/.test(safe)
          ? 409
          : /NOT_FOUND/.test(safe)
            ? 404
            : 400,
      )
      .send({ error: safe });
  });
  let nonce = randomBytes(32).toString("hex");
  let nonceExpiry = Date.now() + 600000;
  const sessions = new Map<string, { csrf: string; expires: number }>();
  const origin = `http://127.0.0.1:${port}`;
  const callback = `http://localhost:${port}/oauth/donationalerts/callback`;
  const same = (a: string, b: string) => {
    const left = Buffer.from(a),
      right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  };
  const bootstrap = () => {
    nonce = randomBytes(32).toString("hex");
    nonceExpiry = Date.now() + 600000;
    return `${origin}/#key=${nonce}`;
  };
  app.addHook("onRequest", async (request, reply) => {
    if (
      ![`127.0.0.1:${port}`, `localhost:${port}`].includes(
        request.headers.host ?? "",
      )
    )
      return reply.code(403).send({ error: "INVALID_HOST" });
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    const path = request.url.split("?")[0]!;
    if (!path.startsWith("/api/")) return;
    if (
      request.headers.origin &&
      request.headers.origin !== origin &&
      request.headers.origin !== `http://localhost:${port}`
    )
      return reply.code(403).send({ error: "INVALID_ORIGIN" });
    if (path === "/api/v1/bootstrap") return;
    const session = sessions.get(request.cookies.sp_session ?? "");
    if (!session || session.expires < Date.now())
      return reply.code(401).send({ error: "LOCAL_LOGIN_REQUIRED" });
    if (
      !["GET", "HEAD"].includes(request.method) &&
      (!same(string(request.headers["x-csrf-token"]), session.csrf) ||
        !request.headers["content-type"]?.startsWith("application/json"))
    )
      return reply.code(403).send({ error: "CSRF_REQUIRED" });
  });
  app.post(
    "/api/v1/bootstrap",
    {
      schema: {
        body: {
          type: "object",
          required: ["key"],
          additionalProperties: false,
          properties: { key: { type: "string", maxLength: 128 } },
        },
      },
    },
    async (request, reply) => {
      const key = string(object(request.body).key);
      if (!nonce || nonceExpiry < Date.now() || !same(key, nonce))
        return reply.code(401).send({ error: "BOOTSTRAP_EXPIRED" });
      nonce = "";
      for (const [id, s] of sessions)
        if (s.expires < Date.now()) sessions.delete(id);
      if (sessions.size > 20)
        return reply.code(429).send({ error: "TOO_MANY_SESSIONS" });
      const id = randomBytes(32).toString("hex"),
        csrf = randomBytes(32).toString("hex");
      sessions.set(id, { csrf, expires: Date.now() + 86400000 });
      reply.setCookie("sp_session", id, {
        httpOnly: true,
        sameSite: "strict",
        path: "/api",
        maxAge: 86400,
      });
      return { csrf };
    },
  );
  app.get("/api/v1/status", async (request) => ({
    twitch: twitch.status,
    donationalerts: da.status,
    device: twitch.device,
    config: { ...configuration.publicView(), daRedirectUri: callback },
    csrf: sessions.get(request.cookies.sp_session ?? "")?.csrf,
    gaps: await db.call("gaps"),
  }));
  app.get("/api/v1/sessions", async () => db.call("sessions"));
  app.post("/api/v1/sessions/start", async () => {
    const existing = await db.call<Record<string, unknown>[]>("sessions");
    if (existing.some((s) => s.ended_at_ms === null))
      throw new Error("SESSION_ALREADY_OPEN");
    return {
      id: await db.call(
        "startSession",
        configuration.value.twitch?.userId || "local",
        `manual-${randomUUID()}`,
        Date.now(),
        "manual",
        Date.now(),
      ),
    };
  });
  app.post("/api/v1/sessions/:id/stop", async (request) => {
    const id = string(object(request.params).id),
      session = (await db.call<Record<string, unknown>[]>("sessions")).find(
        (s) => s.id === id,
      );
    if (!session) throw new Error("SESSION_NOT_FOUND");
    if (session.kind !== "manual")
      throw new Error("PLATFORM_SESSION_MANAGED_AUTOMATICALLY");
    await db.call("endSession", id, Date.now(), "manual");
    return { ok: true };
  });
  app.get("/api/v1/summary", async (request) =>
    db.call("summary", string(object(request.query).session) || undefined),
  );
  app.get("/api/v1/events", async (request) => {
    const q = object(request.query);
    return db.call(
      "events",
      string(q.session) || undefined,
      string(q.person) || undefined,
      q.from === undefined ? undefined : Number(q.from),
      q.to === undefined ? undefined : Number(q.to),
    );
  });
  app.get("/api/v1/persons", async (request) =>
    db.call("persons", string(object(request.query).search)),
  );
  app.get("/api/v1/persons/:id", async (request) =>
    db.call("person", string(object(request.params).id)),
  );
  app.get("/api/v1/persons/:id/candidates", async (request) => {
    const person = await db.call<Record<string, unknown>>(
      "person",
      string(object(request.params).id),
    );
    return db.call("candidatePersons", String(person.display_name));
  });
  app.post("/api/v1/persons/:id/rename", async (request) => {
    await db.call(
      "renamePerson",
      string(object(request.params).id),
      string(object(request.body).name),
    );
    return { ok: true };
  });
  app.post("/api/v1/persons/merge", async (request) => {
    const b = object(request.body);
    return {
      id: await db.call(
        "merge",
        string(b.sourceId),
        string(b.targetId),
        Number(b.sourceRevision),
        Number(b.targetRevision),
        Date.now(),
      ),
    };
  });
  app.post("/api/v1/persons/split", async (request) => {
    const b = object(request.body);
    if (!Array.isArray(b.identityIds) || b.identityIds.length > 1000)
      throw new Error("INVALID_SPLIT");
    return {
      id: await db.call(
        "splitIdentities",
        b.identityIds.map(string),
        string(b.name),
        Number(b.revision),
        Date.now(),
      ),
    };
  });
  app.get("/api/v1/merges", async () => db.call("merges"));
  app.post("/api/v1/merges/:id/undo", async (request) => {
    await db.call("undoMerge", string(object(request.params).id), Date.now());
    return { ok: true };
  });
  app.get("/api/v1/presence", async (request) => {
    const q = object(request.query);
    return db.call(
      "grid",
      string(q.session),
      string(q.person),
      Number(q.from),
      Number(q.to),
    );
  });
  app.post("/api/v1/twitch/connect", async (request) => {
    const b = object(request.body);
    return twitch.beginAuth(string(b.clientId), b.extended === true);
  });
  app.post("/api/v1/twitch/disconnect", async () => {
    await twitch.disconnect();
    return { ok: true };
  });
  app.post("/api/v1/donationalerts/connect", async (request) => {
    const b = object(request.body),
      offset = b.utcOffsetMinutes === null ? null : Number(b.utcOffsetMinutes);
    if (
      offset !== null &&
      (!Number.isInteger(offset) || Math.abs(offset) > 840)
    )
      throw new Error("INVALID_UTC_OFFSET");
    await da.stop();
    configuration.value.daUtcOffsetMinutes = offset;
    if (string(b.clientId)) configuration.value.daClientId = string(b.clientId);
    if (string(b.clientSecret))
      configuration.value.daClientSecret = string(b.clientSecret);
    if (string(b.accessToken)) {
      configuration.value.daAccessToken = string(b.accessToken);
      configuration.value.daRefreshToken = string(b.refreshToken);
    }
    await configuration.save();
    if (string(b.accessToken)) {
      void da.start();
      return { ok: true };
    }
    return { url: da.authUrl(callback) };
  });
  app.get("/oauth/donationalerts/callback", async (request, reply) => {
    try {
      const q = object(request.query);
      await da.finishAuth(string(q.code), string(q.state), callback);
      return reply.redirect(origin + "/");
    } catch {
      return reply
        .code(400)
        .type("text/plain")
        .send(
          "DonationAlerts: вход не завершён. Проверьте redirect URI и state. Вернитесь в панель.",
        );
    }
  });
  app.post("/api/v1/donationalerts/disconnect", async () => {
    await da.disconnect();
    return { ok: true };
  });
  app.post("/api/v1/donationalerts/rescan", async () => {
    void da.scanHistory().catch(() => {});
    return { ok: true };
  });
  app.post("/api/v1/backup", async () => {
    const directory = join(dir, "backups");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = `stream-panel-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`;
    const target = join(directory, filename);
    await db.call("backup", target + ".tmp");
    await rename(target + ".tmp", target);
    return { filename };
  });
  await app.register(staticFiles, {
    root: resolve("apps/web/dist"),
    prefix: "/",
  });
  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith("/api/")
      ? reply.code(404).send({ error: "NOT_FOUND" })
      : reply.sendFile("index.html"),
  );
  app.addHook("onClose", async () => {
    await Promise.all([twitch.stop(), da.stop()]);
    await db.stop();
  });
  if (connect) {
    void twitch.start();
    void da.start();
  }
  return { app, db, configuration, twitch, da, bootstrap };
}
