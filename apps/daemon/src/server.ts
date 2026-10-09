import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StoreClient } from "./db.js";
import { Configuration } from "./config.js";
import {
  TwitchConnection,
  object,
  string,
  type SocketFactory,
} from "./twitch.js";
import { YouTubeConnection } from "./youtube.js";
import { DonationAlertsConnection } from "./donationalerts.js";

export async function createApplication(
  dir: string,
  port: number,
  connect = true,
  transports: {
    youtube?: { request?: typeof fetch };
    twitch?: { request?: typeof fetch; socket?: SocketFactory };
    donationalerts?: { request?: typeof fetch; socket?: SocketFactory };
  } = {},
  options: {
    databasePath?: string;
    profile?: string;
    origin?: string;
    session?: (request: FastifyRequest) => { csrf: string; expires: number } | null;
    staticFiles?: boolean;
  } = {},
) {
  const configuration = new Configuration(dir);
  await configuration.load();
  const db = new StoreClient(options.databasePath ?? join(dir, "data.sqlite"), options.profile);
  await db.ready;
  const twitch = new TwitchConnection(
      configuration,
      db,
      transports.twitch?.request,
      transports.twitch?.socket,
    ),
    da = new DonationAlertsConnection(
      configuration,
      db,
      transports.donationalerts?.request,
      transports.donationalerts?.socket,
    );
  const app = Fastify({
    logger: false,
    bodyLimit: 32768,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
    const detail = error as { code?: string; statusCode?: number };
    const storage = /^(EIO|ENOSPC|EROFS|EACCES|EEXIST|ENOTDIR|ENOENT)$/.test(
      detail.code ?? "",
    );
    const safe = storage
      ? "STORAGE_UNAVAILABLE"
      : /^[A-Z0-9_]+$/.test(code)
        ? code
        : "REQUEST_FAILED";
    const clientStatus =
      detail.statusCode && detail.statusCode >= 400 && detail.statusCode < 500
        ? detail.statusCode
        : undefined;
    const clientFailure =
      /^(INVALID_|MISSING_|TWITCH_|DA_|ANALYTICS_|UNSUPPORTED_CURRENCY$|SAME_PERSON$|EMPTY_PERSON$|ALREADY_UNDONE$|PLATFORM_SESSION_MANAGED_AUTOMATICALLY$)/.test(
        safe,
      );
    reply
      .code(
        clientStatus ??
          (/CONFLICT|ALREADY_OPEN/.test(safe)
            ? 409
            : /NOT_FOUND/.test(safe)
              ? 404
              : storage || /^(DB_|QUEUE_OVERFLOW|SQLITE_)/.test(safe)
                ? 503
                : clientFailure
                  ? 400
                  : 500),
      )
      .send({ error: safe });
  });
  const text = { type: "string", maxLength: 256, minLength: 1 };
  const revision = { type: "integer", minimum: 0 };
  const body = (
    properties: Record<string, unknown> = {},
    required: string[] = [],
  ): Record<string, unknown> => ({
    type: "object",
    additionalProperties: false,
    properties,
    required,
  });
  const schemaBodies: Record<string, Record<string, unknown>> = {
    "/api/v1/persons/:id/notes": body({body:{type:"string",minLength:1,maxLength:10000}},["body"]),
    "/api/v1/persons/:id/notes/:noteId/update": body({body:{type:"string",minLength:1,maxLength:10000},revision},["body","revision"]),
    "/api/v1/persons/:id/notes/:noteId/delete": body({revision},["revision"]),
    "/api/v1/sessions/start": body(),
    "/api/v1/sessions/:id/stop": body(),
    "/api/v1/persons/:id/rename": body(
      { name: { type: "string", minLength: 1, maxLength: 200 } },
      ["name"],
    ),
    "/api/v1/persons/merge": body(
      {
        sourceId: text,
        targetId: text,
        sourceRevision: revision,
        targetRevision: revision,
      },
      ["sourceId", "targetId", "sourceRevision", "targetRevision"],
    ),
    "/api/v1/persons/split": body(
      {
        identityIds: {
          type: "array",
          items: text,
          minItems: 1,
          maxItems: 1000,
          uniqueItems: true,
        },
        name: { type: "string", minLength: 1, maxLength: 200 },
        revision,
      },
      ["identityIds", "name", "revision"],
    ),
    "/api/v1/merges/:id/undo": body(),
    "/api/v1/youtube/connect": body({clientId:text,clientSecret:{type:"string",maxLength:256}},["clientId"]),
    "/api/v1/youtube/disconnect": body(),
    "/api/v1/twitch/connect": body(
      { clientId: text, extended: { type: "boolean" } },
      ["clientId"],
    ),
    "/api/v1/twitch/disconnect": body(),
    "/api/v1/donationalerts/connect": body(
      {
        clientId: { type: "string", maxLength: 256 },
        clientSecret: { type: "string", maxLength: 4096 },
        accessToken: { type: "string", maxLength: 4096 },
        refreshToken: { type: "string", maxLength: 4096 },
        utcOffsetMinutes: {
          anyOf: [
            { type: "integer", minimum: -840, maximum: 840 },
            { type: "null" },
          ],
        },
      },
      ["utcOffsetMinutes"],
    ),
    "/api/v1/donationalerts/disconnect": body(),
    "/api/v1/donationalerts/rescan": body(),
    "/api/v1/backup": body(),
  };
  app.addHook("onRoute", (route) => {
    if (route.method === "POST" && schemaBodies[route.url])
      route.schema = { ...route.schema, body: schemaBodies[route.url] };
  });
  let nonce = randomBytes(32).toString("hex");
  let nonceExpiry = Date.now() + 600000;
  const sessions = new Map<string, { csrf: string; expires: number }>();
  const origin = options.origin ?? `http://127.0.0.1:${port}`;
  const callback = `${origin}/oauth/donationalerts/callback`;
  const youtube = new YouTubeConnection(configuration, db, `${origin}/oauth/youtube/callback`, options.profile ?? "local", transports.youtube?.request);
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
      !(options.origin ? [new URL(origin).host] : [`127.0.0.1:${port}`, `localhost:${port}`]).includes(
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
    const session = options.session ? options.session(request) : sessions.get(request.cookies.sp_session ?? "");
    if (!session || session.expires < Date.now())
      return reply.code(401).send({ error: "LOCAL_LOGIN_REQUIRED" });
    if (
      !["GET", "HEAD"].includes(request.method) &&
      (!same(string(request.headers["x-csrf-token"]), session.csrf) ||
        !request.headers["content-type"]?.startsWith("application/json"))
    )
      return reply.code(403).send({ error: "CSRF_REQUIRED" });
  });
  if (!options.session) app.post(
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
  app.get("/api/v1/analytics", async request => {
    const q=object(request.query);
    return db.call("analytics", {
      fromMs:Number(q.from),toMs:Math.min(Number(q.to),Date.now()),source:string(q.source)||"all",category:string(q.category),
      regularThresholdPercent:q.regularThresholdPercent===undefined?50:Number(q.regularThresholdPercent),minSessions:q.minSessions===undefined?3:Number(q.minSessions),minMinutes:q.minMinutes===undefined?30:Number(q.minMinutes),minMessages:q.minMessages===undefined?5:Number(q.minMessages),
      chatWindowMinutes:q.chatWindowMinutes===undefined?5:Number(q.chatWindowMinutes),coreRule:string(q.coreRule)||"either",timezone:string(q.timezone)||"Europe/Moscow",
      excludedLogins:configuration.value.excludedBotLogins,ownerId:configuration.value.twitch?.userId??"",youtubeAccount:configuration.value.youtube?.userId??configuration.value.youtubeAccountId??"",
    });
  });
  app.get("/api/v1/status", async (request) => ({
    youtube: youtube.status,
    twitch: twitch.status,
    donationalerts: da.status,
    device: twitch.device,
    config: { ...configuration.publicView(), daRedirectUri: callback, youtubeRedirectUri: `${origin}/oauth/youtube/callback` },
    csrf: (options.session ? options.session(request) : sessions.get(request.cookies.sp_session ?? ""))?.csrf,
    serverMode: Boolean(options.session),
    profile: options.profile ?? null,
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
    db.call(
      "summary",
      string(object(request.query).session) || undefined,
      configuration.value.excludedBotLogins,
    ),
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
    db.call(
      "persons",
      string(object(request.query).search),
      configuration.value.excludedBotLogins,
    ),
  );
  app.get("/api/v1/persons/tops", async (request) => {
    const q = object(request.query);
    const sortRaw = string(q.by) || "messages";
    const sortBy =
      sortRaw === "donations" || sortRaw === "observed_minutes"
        ? sortRaw
        : "messages";
    return db.call(
      "personsTop",
      sortBy,
      string(q.session) || undefined,
      configuration.value.excludedBotLogins,
      q.limit === undefined ? 50 : Number(q.limit),
    );
  });
  app.get("/api/v1/insights", async (request) =>
    db.call(
      "insights",
      string(object(request.query).session) || undefined,
      configuration.value.excludedBotLogins,
    ),
  );
  app.get("/api/v1/persons/:id", async (request) =>
    db.call("person", string(object(request.params).id)),
  );
  app.get("/api/v1/persons/:id/notes", async request => db.call("personNotes",string(object(request.params).id)));
  app.post("/api/v1/persons/:id/notes", async request => db.call("createPersonNote",string(object(request.params).id),string(object(request.body).body)));
  app.post("/api/v1/persons/:id/notes/:noteId/update", async request => {
    const p=object(request.params), b=object(request.body);
    return db.call("updatePersonNote",string(p.id),string(p.noteId),string(b.body),Number(b.revision));
  });
  app.post("/api/v1/persons/:id/notes/:noteId/delete", async request => {
    const p=object(request.params);
    await db.call("deletePersonNote",string(p.id),string(p.noteId),Number(object(request.body).revision));
    return {ok:true};
  });
  app.get("/api/v1/persons/:id/stats", async (request) => {
    const id = string(object(request.params).id);
    const session = string(object(request.query).session) || undefined;
    return db.call(
      "personStats",
      id,
      session,
      configuration.value.excludedBotLogins,
    );
  });
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
  app.post("/api/v1/youtube/connect", async request => {
    const b = object(request.body);
    return youtube.beginAuth(string(b.clientId), string(b.clientSecret));
  });
  app.post("/api/v1/youtube/disconnect", async () => { await youtube.disconnect(); return {ok:true}; });
  app.get("/api/v1/youtube/data", async () => db.call("youtubeData", configuration.value.youtube?.userId ?? configuration.value.youtubeAccountId ?? ""));
  app.get("/oauth/youtube/callback", async (request, reply) => {
    try { const q = object(request.query); await youtube.finishAuth(string(q.code), string(q.state)); return reply.redirect(origin + "/"); }
    catch { return reply.code(400).type("text/plain").send("YouTube: вход не завершён. Проверьте права и redirect URI; вернитесь в панель."); }
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
  if (options.staticFiles !== false) await app.register(staticFiles, {
    // Resolve from this module, not process.cwd() — daemon may start elsewhere.
    root: join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../apps/web/dist",
    ),
    prefix: "/",
  });
  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith("/api/")
      ? reply.code(404).send({ error: "NOT_FOUND" })
      : options.staticFiles === false ? reply.code(404).send({ error: "NOT_FOUND" }) : reply.sendFile("index.html"),
  );
  app.addHook("onClose", async () => {
    await Promise.all([twitch.stop(), da.stop(), youtube.stop()]);
    await db.stop();
  });
  if (connect) {
    void twitch.start();
    void da.start(); void youtube.start();
  }
  return { app, db, configuration, twitch, da, youtube, bootstrap };
}
