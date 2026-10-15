import {registerRouteSchemas} from './route-schemas.js';
import {registerPeopleRoutes} from './people-routes.js';
import {registerDonationsRoutes} from './donations-routes.js';
import {registerStreamsRoutes} from './streams-routes.js';
import {object, string} from './provider-values.js';
import {prepareChatStorage} from "./chat-cleanup.js";
import {DA_API_UTC_OFFSET_MINUTES} from '../../../packages/core/src/donation-time.js';
import {analyticsSettings} from "./analytics-settings.js";
import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StoreClient } from "./db.js";
import { Configuration } from "./config.js";
import {
  TwitchConnection,
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
    canViewCredentials?: (request: FastifyRequest) => boolean;
    staticFiles?: boolean;
  } = {},
) {
  const configuration = new Configuration(dir);
  await configuration.load();
  // Source dates are UTC even when the DA cabinet and panel display Moscow time.
  if(!configuration.value.daApiUtcClockApplied||configuration.value.daUtcOffsetMinutes!==DA_API_UTC_OFFSET_MINUTES){
    configuration.value.daUtcOffsetMinutes=DA_API_UTC_OFFSET_MINUTES;
    configuration.value.daApiUtcClockApplied=true;
    await configuration.save();
  }
  if(!options.databasePath)await prepareChatStorage(join(dir,"data.sqlite"));
  const db = new StoreClient(options.databasePath ?? join(dir, "data.sqlite"), options.profile);
  await db.ready;
  try{await db.call('resolveDonationTimes',DA_API_UTC_OFFSET_MINUTES);}catch(error){await db.stop();throw error;}
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
              : storage || /^(DB_|QUEUE_OVERFLOW|SQLITE_|STORAGE_)/.test(safe)
                ? 503
                : clientFailure
                  ? 400
                  : 500),
      )
      .send({ error: safe });
  });
  registerRouteSchemas(app);
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
  // Local bootstrap sessions have no hosted account; the common onRequest hook
  // still requires a valid session before this capability response is returned.
  app.get('/api/v1/auth/me',()=>({user:null}));
  registerPeopleRoutes(app, db, configuration);
  registerDonationsRoutes(app, db, configuration);
  registerStreamsRoutes(app, db, configuration);

  app.get('/api/v1/settings',()=>analyticsSettings(configuration.value.analyticsSettings));
  app.post('/api/v1/settings',async request=>{
    const next=analyticsSettings(request.body);const previous=analyticsSettings(configuration.value.analyticsSettings);
    configuration.value.analyticsSettings=next;
    try{await configuration.save();}catch(error){configuration.value.analyticsSettings=previous;throw error;}
    return next;
  });


  app.post('/api/v1/integrations/credentials',{schema:{body:{type:'object',additionalProperties:false,properties:{}}}},async(request,reply)=>{
    if(options.canViewCredentials&&!options.canViewCredentials(request))return reply.code(403).send({error:'CREDENTIALS_FORBIDDEN'});
    const config=configuration.value;
    return {
      twitch:{clientId:config.twitchClientId,...config.twitch},
      youtube:{clientId:config.youtubeClientId??'',clientSecret:config.youtubeClientSecret??'',...config.youtube},
      donationalerts:{clientId:config.daClientId,clientSecret:config.daClientSecret,access:config.daAccessToken,refresh:config.daRefreshToken},
    };
  });
  app.get("/api/v1/status", async (request) => ({
    storage:db.storageStatus(),
    database:db.queueStatus(),
    release:process.env.STREAM_PANEL_RELEASE??'development',
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
      offset = b.utcOffsetMinutes === null ? null : Number(b.utcOffsetMinutes),
      clientId = string(b.clientId).trim(),
      clientSecret = string(b.clientSecret).trim(),
      accessToken = string(b.accessToken).trim();
    if (
      offset !== null &&
      (!Number.isInteger(offset) || Math.abs(offset) > 840)
    )
      throw new Error("INVALID_UTC_OFFSET");
    if (!accessToken) {
      const effectiveClientId = clientId || configuration.value.daClientId.trim();
      const effectiveClientSecret = clientSecret || configuration.value.daClientSecret.trim();
      if (!effectiveClientId || !effectiveClientSecret)
        throw new Error("DA_APP_CREDENTIALS_REQUIRED");
      let secretUrl: URL | null = null;
      try { secretUrl = new URL(effectiveClientSecret); } catch { /* Opaque OAuth secrets are not URLs. */ }
      if (secretUrl && (secretUrl.protocol === "http:" || secretUrl.protocol === "https:"))
        throw new Error("DA_CLIENT_SECRET_IS_URL");
    }
    await da.stop();
    configuration.value.daUtcOffsetMinutes = DA_API_UTC_OFFSET_MINUTES;
    if (clientId) configuration.value.daClientId = clientId;
    if (clientSecret) configuration.value.daClientSecret = clientSecret;
    if (accessToken) {
      configuration.value.daAccessToken = accessToken;
      configuration.value.daRefreshToken = string(b.refreshToken);
    }
    await configuration.save();
    if (accessToken) {
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
    } catch (error) {
      return reply
        .code(400)
        .type("text/plain")
        .send(
          error instanceof Error && error.message === "DA_OAUTH_HTTP_401"
            ? "DonationAlerts отклонил Client ID или Client Secret. Скопируйте секрет приложения из кабинета DA, а Redirect URI укажите отдельно; затем повторите подключение из панели."
            : "DonationAlerts: вход не завершён. Проверьте redirect URI и state. Вернитесь в панель.",
        );
    }
  });
  app.post("/api/v1/donationalerts/disconnect", async () => {
    await da.disconnect();
    return { ok: true };
  });
  app.post('/api/v1/donationalerts/timezone',async request=>{
    const offset=Number(object(request.body).utcOffsetMinutes),previous=configuration.value.daUtcOffsetMinutes;
    if(offset!==DA_API_UTC_OFFSET_MINUTES)throw new Error('INVALID_API_TIMEZONE');
    configuration.value.daUtcOffsetMinutes=DA_API_UTC_OFFSET_MINUTES;
    try{await configuration.save();}catch(error){configuration.value.daUtcOffsetMinutes=previous;throw error;}
    return db.call('resolveDonationTimes',offset);
  });
  app.post("/api/v1/donationalerts/rescan", async (request) => {
    if(!configuration.value.daAccessToken)throw new Error('DA_LOGIN_REQUIRED');
    await da.scanHistory(string(object(request.query).recent)==="1");
    return { ok: true, history:da.status.capabilities.history };
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
