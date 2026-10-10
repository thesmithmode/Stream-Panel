import WebSocket from "ws";
import {extraTwitchEvents,extraTwitchScopes} from './twitch-events.js';
import type { Configuration, Tokens } from "./config.js";
import type { StoreClient } from "./db.js";
import {
  collectChatters,
  type ChattersPage,
} from "../../../packages/core/src/chatters.js";
import type { EventInput } from "../../../packages/core/src/domain.js";

export type SocketFactory = (
  url: string,
  options: WebSocket.ClientOptions,
) => WebSocket;

export interface ConnectionStatus {
  state: string;
  detail: string;
  account?: string;
  lastEventAt?: number;
  capabilities: Record<string, string>;
}
export const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_PROVIDER_OBJECT");
  return value as Record<string, unknown>;
};
export const string = (value: unknown): string =>
  typeof value === "string" ? value : "";

export function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value))
    return string((value as Record<string, unknown>).text);
  return "";
}
const baseScopes = ["user:read:chat", "moderator:read:chatters"];
const optionalScopes = [
  "moderator:read:followers",
  "channel:read:subscriptions",
  "bits:read",
  ...extraTwitchScopes,
];

export function normalizeTwitch(
  envelope: unknown,
  accountId: string,
): EventInput | null {
  const root = object(envelope),
    metadata = object(root.metadata),
    payload = object(root.payload);
  if (metadata.message_type !== "notification") return null;
  const event = object(payload.event),
    subscription = object(payload.subscription),
    type = string(subscription.type);
  const mappings: Record<string, string> = {
    "channel.chat.message": "chat.message",
    "channel.cheer": "bits",
    "channel.follow": "follow",
    "channel.update": "channel.update",
    "channel.subscribe": "subscription",
    "channel.subscription.gift": "subscription.gift",
    "channel.subscription.message": "subscription.message",
    "channel.raid": "raid",
    "stream.online": "stream.online",
    "stream.offline": "stream.offline",
    "channel.chat.message_delete": "chat.message_delete",
    "channel.chat.clear": "chat.clear",
    "channel.chat.clear_user_messages": "chat.clear_user_messages",
  };
  const mapped = mappings[type] ?? (extraTwitchEvents.some(([name])=>name===type)?type.replace(/^channel\./,''):undefined);
  if (!mapped) return null;
  const userId =
    string(event.chatter_user_id) ||
    string(event.user_id) ||
    string(event.from_broadcaster_user_id);
  const label =
    string(event.chatter_user_name) ||
    string(event.user_name) ||
    string(event.from_broadcaster_user_name);
  const time =
    string(event.followed_at) ||
    string(event.started_at) ||
    string(metadata.message_timestamp);
  const at = Date.parse(time);
  if (!Number.isFinite(at)) throw new Error("INVALID_PROVIDER_TIME");
  const chat = mapped === "chat.message";
  const id = chat ? string(event.message_id) : string(metadata.message_id);
  if (!id) throw new Error("MISSING_PROVIDER_EVENT_ID");
  return {
    source: "twitch",
    accountId,
    externalId: id,
    type: mapped,
    actor:
      userId && !event.is_anonymous && (!mapped.startsWith("chat.") || chat)
        ? { externalId: userId, displayName: label || userId }
        : null,
    occurredAtMs: at,
    receivedAtMs: Date.now(),
    sourceTime: time,
    timeQuality: "provider",
    transport: "eventsub",
    payload: {
      raw:root,
      text: messageText(event.message) || string(event.user_input),
      reward:event.reward??null,
      actorName: label,
      originChannelId: string(event.source_broadcaster_user_id) || accountId,
      bits: event.bits ?? null,
      subscriptionType: type,
      ...(mapped === "channel.update" ? {categoryId:string(event.category_id),categoryName:string(event.category_name),title:string(event.title)} : {}),
      targetMessageId: string(event.message_id),
      targetUserId: string(event.target_user_id),
      timeBasis:
        event.followed_at || event.started_at ? "event" : "publication",
    },
  };
}

/** Clear tokens only on definitive OAuth failure (400/401 or invalid_grant). */
export function isDefinitiveTwitchAuthFailure(
  status: number,
  body: Record<string, unknown>,
): boolean {
  if (status === 400 || status === 401) return true;
  const error = string(body.error).toLowerCase();
  if (
    error === "invalid_grant" ||
    error === "unauthorized" ||
    error === "invalid_token"
  )
    return true;
  const message = string(body.message).toLowerCase();
  return (
    message.includes("invalid refresh token") ||
    message.includes("invalid_grant") ||
    message.includes("unauthorized")
  );
}

export class TwitchConnection {
  status: ConnectionStatus = {
    state: "disconnected",
    detail: "Не подключён",
    capabilities: {},
  };
  device: {
    verificationUri: string;
    userCode: string;
    expiresAt: number;
  } | null = null;
  private stopped = true;
  private socket: WebSocket | null = null;
  private retry: NodeJS.Timeout | null = null;
  private tick: NodeJS.Timeout | null = null;
  private hourly: NodeJS.Timeout | null = null;
  private refreshPromise: Promise<void> | null = null;
  private reconcilingGeneration: number | null = null;
  private reconcileRequested = false;
  private platformLive = false;
  private eventSubReady = false;
  private reconcileError: string | null = null;
  private reconnectAttempt = 0;
  private sessionId: string | null = null;
  private lastSuccessfulPollAt: number | null = null;
  private authGeneration = 0;
  private gapStart: number | null = null;
  private rateLimitedUntil = 0;
  private sockets = new Set<WebSocket>();
  constructor(
    private config: Configuration,
    private db: StoreClient,
    private request: typeof fetch = fetch,
    private socketFactory: SocketFactory = (url, options) =>
      new WebSocket(url, options),
    private now: () => number = Date.now,
  ) {}
  private get token(): Tokens {
    if (!this.config.value.twitch) throw new Error("TWITCH_LOGIN_REQUIRED");
    return this.config.value.twitch;
  }
  async beginAuth(clientId: string, extended: boolean): Promise<unknown> {
    if (!/^[a-zA-Z0-9]{5,100}$/.test(clientId))
      throw new Error("INVALID_CLIENT_ID");
    await this.stop();
    const generation = this.authGeneration;
    this.config.value.twitchClientId = clientId;
    await this.config.save();
    const scopes = [...baseScopes, ...(extended ? optionalScopes : [])];
    const response = await this.request("https://id.twitch.tv/oauth2/device", {
      method: "POST",
      body: new URLSearchParams({
        client_id: clientId,
        scopes: scopes.join(" "),
      }),
      signal: AbortSignal.timeout(15000),
    });
    const body = object(await response.json());
    if (generation !== this.authGeneration)
      throw new Error("TWITCH_AUTH_CANCELLED");
    if (!response.ok) throw new Error(`TWITCH_DEVICE_HTTP_${response.status}`);
    const deviceCode = string(body.device_code);
    if (!deviceCode) throw new Error("INVALID_DEVICE_RESPONSE");
    const expiresAt = Date.now() + Number(body.expires_in) * 1000;
    const interval = Math.max(5, Number(body.interval) || 5) * 1000;
    this.device = {
      verificationUri: string(body.verification_uri),
      userCode: string(body.user_code),
      expiresAt,
    };
    this.status = {
      state: "authorizing",
      detail: "Подтвердите вход на Twitch",
      capabilities: {},
    };
    void this.pollDevice(deviceCode, scopes, interval, expiresAt, generation);
    return this.device;
  }
  private async pollDevice(
    code: string,
    scopes: string[],
    interval: number,
    expiresAt: number,
    generation: number,
  ): Promise<void> {
    while (generation === this.authGeneration && Date.now() < expiresAt) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      if (generation !== this.authGeneration) return;
      try {
        const response = await this.request(
          "https://id.twitch.tv/oauth2/token",
          {
            method: "POST",
            body: new URLSearchParams({
              client_id: this.config.value.twitchClientId,
              device_code: code,
              scopes: scopes.join(" "),
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
            signal: AbortSignal.timeout(15000),
          },
        );
        const body = object(await response.json());
        if (!response.ok) {
          if (body.message === "authorization_pending") continue;
          if (body.message === "slow_down") {
            interval += 5000;
            continue;
          }
          throw new Error(`TWITCH_AUTH_HTTP_${response.status}`);
        }
        if (generation !== this.authGeneration) return;
        this.config.value.twitch = {
          access: string(body.access_token),
          refresh: string(body.refresh_token),
          expiresAt: Date.now() + Number(body.expires_in) * 1000,
          userId: "",
          scopes: Array.isArray(body.scope) ? body.scope.map(string) : scopes,
        };
        await this.config.save();
        this.device = null;
        await this.start();
        return;
      } catch (error) {
        this.status.detail =
          error instanceof Error ? error.message : "TWITCH_AUTH_ERROR";
        if (generation !== this.authGeneration) return;
      }
    }
    if (generation === this.authGeneration) {
      this.device = null;
      this.status.state = "error";
      this.status.detail = "Время входа истекло — повторите";
    }
  }
  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const generation = this.authGeneration;
    this.refreshPromise = (async () => {
      let response: Response;
      try {
        response = await this.request("https://id.twitch.tv/oauth2/token", {
          method: "POST",
          body: new URLSearchParams({
            client_id: this.config.value.twitchClientId,
            grant_type: "refresh_token",
            refresh_token: this.token.refresh,
          }),
          signal: AbortSignal.timeout(15000),
        });
      } catch (error) {
        // Network/timeout: keep tokens so reconnect/backoff can retry.
        throw error instanceof Error
          ? error
          : new Error("TWITCH_REFRESH_TRANSIENT");
      }
      let body: Record<string, unknown>;
      try {
        body = object(await response.json());
      } catch (parseError) {
        // Non-JSON error bodies (e.g. HTML 5xx) still classify by status.
        if (response.ok) throw parseError;
        body = {};
      }
      if (generation !== this.authGeneration)
        throw new Error("TWITCH_AUTH_CANCELLED");
      if (!response.ok) {
        if (isDefinitiveTwitchAuthFailure(response.status, body)) {
          // Expired/revoked refresh: clear credentials so reconnect stops looping.
          delete this.config.value.twitch;
          await this.config.save();
          this.status = {
            state: "error",
            detail: "Требуется повторный вход в Twitch",
            capabilities: {},
          };
          throw new Error("TWITCH_REAUTH_REQUIRED");
        }
        // 429/5xx/other: keep tokens for existing reconnect/backoff.
        throw new Error(`TWITCH_REFRESH_HTTP_${response.status}`);
      }
      const previous = this.token;
      this.config.value.twitch = {
        ...previous,
        access: string(body.access_token),
        // Mirror DA: providers may omit refresh_token; keep the previous one.
        refresh: string(body.refresh_token) || previous.refresh,
        expiresAt: Date.now() + Number(body.expires_in) * 1000,
      };
      await this.config.save();
    })();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }
  async api(
    path: string,
    init: RequestInit = {},
    retried = false,
  ): Promise<unknown> {
    if (Date.now() < this.rateLimitedUntil)
      throw new Error(
        `TWITCH_RATE_LIMIT_UNTIL_${Math.ceil(this.rateLimitedUntil / 1000)}`,
      );
    if (this.token.expiresAt < Date.now() + 60_000) await this.refresh();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token.access}`);
    headers.set("Client-Id", this.config.value.twitchClientId);
    const response = await this.request(`https://api.twitch.tv/helix/${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(15000),
    });
    if (response.status === 401 && !retried) {
      await this.refresh();
      return this.api(path, init, true);
    }
    if (response.status === 429) {
      const reset = Number(response.headers.get("ratelimit-reset"));
      this.rateLimitedUntil =
        Number.isFinite(reset) && reset * 1000 > Date.now()
          ? reset * 1000
          : Date.now() + 60000;
      throw new Error(
        `TWITCH_RATE_LIMIT_UNTIL_${Math.ceil(this.rateLimitedUntil / 1000)}`,
      );
    }
    if (!response.ok) throw new Error(`TWITCH_HTTP_${response.status}`);
    return response.json();
  }
  private async validate(): Promise<void> {
    const generation = this.authGeneration;
    if (this.token.expiresAt < Date.now() + 60_000) await this.refresh();
    let response = await this.request("https://id.twitch.tv/oauth2/validate", {
      headers: { Authorization: `OAuth ${this.token.access}` },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 401) {
      await this.refresh();
      response = await this.request("https://id.twitch.tv/oauth2/validate", {
        headers: { Authorization: `OAuth ${this.token.access}` },
        signal: AbortSignal.timeout(15000),
      });
    }
    const body = object(await response.json());
    if (generation !== this.authGeneration)
      throw new Error("TWITCH_AUTH_CANCELLED");
    if (
      !response.ok ||
      body.client_id !== this.config.value.twitchClientId ||
      !string(body.user_id)
    )
      throw new Error("TWITCH_TOKEN_MISMATCH");
    this.token.userId = string(body.user_id);
    this.token.scopes = Array.isArray(body.scopes)
      ? body.scopes.map(string)
      : [];
    if (!this.token.scopes.includes("user:read:chat"))
      throw new Error("MISSING_CHAT_SCOPE");
    await this.config.save();
    if (generation !== this.authGeneration) throw new Error("TWITCH_AUTH_CANCELLED");
    this.status.account = string(body.login);
    if (string(body.login) && !this.config.value.excludedBotLogins.includes(string(body.login))) {
      this.config.value.excludedBotLogins.push(string(body.login)); await this.config.save();
      if (generation !== this.authGeneration) throw new Error("TWITCH_AUTH_CANCELLED");
    }
    await this.db.call(
      "ensureOwnerIdentity",
      this.token.userId,
      this.token.userId,
      string(body.login) || this.token.userId,
      Date.now(),
    );
  }
  async start(): Promise<void> {
    if (!this.config.value.twitch) {
      this.status = {
        state: "disconnected",
        detail: "Не подключён",
        capabilities: {},
      };
      return;
    }
    await this.stop();
    this.stopped = false;
    const generation = this.authGeneration;
    this.status.state = "connecting";
    this.status.detail = "Подключение…";
    try {
      await this.validate();
      if (this.stopped || generation !== this.authGeneration) return;
      this.connect();
      this.hourly = setInterval(() => {
        void this.validate().catch((error) => this.report(error));
      }, 3_600_000);
      // Reconcile/chatters failures must not tear down a healthy EventSub.
      void this.reconcile().catch((error) => this.report(error));
    } catch (error) {
      if (this.stopped || generation !== this.authGeneration) return;
      this.report(error);
      if (
        error instanceof Error &&
        error.message === "TWITCH_REAUTH_REQUIRED"
      )
        return;
      this.scheduleReconnect();
    }
  }
  private connect(
    url = "wss://eventsub.wss.twitch.tv/ws",
    handoff = false,
  ): void {
    if (this.stopped) return;
    const generation = this.authGeneration,
      old = this.socket;
    const socket = this.socketFactory(url, { maxPayload: 1048576 });
    this.sockets.add(socket);
    if (!handoff) this.socket = socket;
    let keepalive = 15_000;
    let timer: NodeJS.Timeout | null = null;
    const reset = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => socket.terminate(), keepalive + 5000);
    };
    reset();
    socket.on("message", (data) => {
      reset();
      void (async () => {
        if (this.stopped || generation !== this.authGeneration) return;
        const body = object(JSON.parse(data.toString())),
          meta = object(body.metadata),
          payload = object(body.payload),
          kind = meta.message_type;
        if (kind === "session_welcome") {
          const session = object(payload.session);
          keepalive = Number(session.keepalive_timeout_seconds) * 1000 || 15000;
          reset();
          if (handoff) {
            this.socket = socket;
            old?.close();
          } else await this.subscribe(string(session.id));
          this.status.state = "connected";
          this.status.detail = "Сбор событий включён";
          this.eventSubReady = true;
          this.reconnectAttempt = 0;
          if (this.gapStart !== null) {
            await this.db.call(
              "gap",
              "twitch",
              "connection_lost_no_replay",
              this.gapStart,
              Date.now(),
            );
            this.gapStart = null;
          }
        } else if (kind === "session_reconnect") {
          const next = string(object(payload.session).reconnect_url);
          const nextUrl = new URL(next);
          if (
            nextUrl.protocol !== "wss:" ||
            nextUrl.hostname !== "eventsub.wss.twitch.tv"
          )
            throw new Error("INVALID_RECONNECT_URL");
          this.connect(next, true);
        } else if (kind === "revocation") {
          const sub = object(payload.subscription);
          this.status.capabilities[string(sub.type)] = string(sub.status);
          this.status.detail = "Часть подписок отозвана";
        } else if (kind === "notification") {
          const event = normalizeTwitch(body, this.token.userId);
          if (event) {
            await this.db.call("ingest", event);
            this.status.lastEventAt = Date.now();
            if (
              event.type === "stream.online" ||
              event.type === "stream.offline"
            )
              await this.reconcile();
          }
        }
      })().catch((error) => this.report(error));
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
      if (timer) clearTimeout(timer);
      if (
        !this.stopped &&
        generation === this.authGeneration &&
        (this.socket === socket || (handoff && this.socket === old))
      ) {
        this.eventSubReady = false;
        this.status.state = "degraded";
        this.status.detail = "Соединение потеряно; повторное подключение";
        this.gapStart ??= Date.now();
        this.scheduleReconnect();
      }
    });
    socket.on("error", () => {
      this.status.detail = "Ошибка WebSocket";
    });
  }
  private async subscribe(sessionId: string): Promise<void> {
    const id = this.token.userId;
    const definitions: [
      string,
      string,
      Record<string, string>,
      string | null,
    ][] = [
      [
        "channel.chat.message",
        "1",
        { broadcaster_user_id: id, user_id: id },
        "user:read:chat",
      ],
      ...[
        "channel.chat.message_delete",
        "channel.chat.clear",
        "channel.chat.clear_user_messages",
      ].map(
        (type) =>
          [
            type,
            "1",
            { broadcaster_user_id: id, user_id: id },
            "user:read:chat",
          ] as [string, string, Record<string, string>, string],
      ),
      ["channel.update", "2", { broadcaster_user_id: id }, null],
      ["stream.online", "1", { broadcaster_user_id: id }, null],
      ["stream.offline", "1", { broadcaster_user_id: id }, null],
      ["channel.raid", "1", { to_broadcaster_user_id: id }, null],
      [
        "channel.follow",
        "2",
        { broadcaster_user_id: id, moderator_user_id: id },
        "moderator:read:followers",
      ],
      ...[
        "channel.subscribe",
        "channel.subscription.gift",
        "channel.subscription.message",
      ].map(
        (type) =>
          [
            type,
            "1",
            { broadcaster_user_id: id },
            "channel:read:subscriptions",
          ] as [string, string, Record<string, string>, string],
      ),
      ["channel.cheer", "1", { broadcaster_user_id: id }, "bits:read"],
      ...extraTwitchEvents.map(([type,version,scope])=>[type,version,
        type.startsWith('channel.chat')?{broadcaster_user_id:id,user_id:id}:{broadcaster_user_id:id},scope] as [string,string,Record<string,string>,string|null]),
    ];
    for (const [type, version, condition, scope] of definitions) {
      if (scope && !this.token.scopes.includes(scope)) {
        this.status.capabilities[type] = "Нет разрешения";
        continue;
      }
      try {
        await this.api("eventsub/subscriptions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type,
            version,
            condition,
            transport: { method: "websocket", session_id: sessionId },
          }),
        });
        this.status.capabilities[type] = "включено";
      } catch (error) {
        this.status.capabilities[type] =
          error instanceof Error ? error.message : "error";
        if (type === "channel.chat.message") throw error;
      }
    }
  }
  private async reconcile(): Promise<void> {
    if (this.stopped) return;
    if (this.reconcilingGeneration === this.authGeneration) { this.reconcileRequested = true; return; }
    if (this.tick) clearTimeout(this.tick);
    this.tick = null;
    const generation = this.authGeneration;
    const accountId = this.token.userId;
    const current = () => !this.stopped && generation === this.authGeneration;
    this.reconcilingGeneration = generation;
    try {
      const body = object(
        await this.api(`streams?user_id=${encodeURIComponent(accountId)}`),
      );
      if (!current()) return;
      if (!Array.isArray(body.data) || body.data.length > 1)
        throw new Error("INVALID_TWITCH_STREAMS");
      const previousSession = this.sessionId;
      const observedAtMs = this.now();
      if (body.data.length) {
        const stream = object(body.data[0]);
        const externalId = string(stream.id);
        const startedAtMs = Date.parse(string(stream.started_at));
        if (!externalId || !Number.isFinite(startedAtMs) ||
          (stream.user_id !== undefined && stream.user_id !== accountId) ||
          (stream.type !== undefined && stream.type !== "live"))
          throw new Error("INVALID_TWITCH_STREAM");
        const login = string(stream.user_login);
        const url = /^[a-zA-Z0-9_]{1,25}$/.test(login)
          ? `https://www.twitch.tv/${login}` : null;
        const sessionId = await this.db.call<string | null>(
          "observePlatformStream", "twitch", accountId, externalId,
          startedAtMs, observedAtMs, url, string(stream.title), [externalId],
        );
        if (!current()) return;
        this.platformLive = true;
        this.sessionId = sessionId;
        if (sessionId) await this.db.call("providerSnapshot",'twitch',accountId,'stream',stream,observedAtMs,sessionId);
        if (sessionId) await this.db.call("streamSample", sessionId, observedAtMs,
          string(stream.game_id), string(stream.game_name), string(stream.title),
          Number.isSafeInteger(stream.viewer_count) ? Number(stream.viewer_count) : null);
        if (!current()) return;
      } else {
        await this.db.call("platformMissing", "twitch", accountId, [], observedAtMs);
        if (!current()) return;
        const active = await this.db.call<Record<string, unknown> | null>("activeLogicalStream");
        if (!current()) return;
        const links = active
          ? await this.db.call<Record<string, unknown>[]>("platformStreams", String(active.id))
          : [];
        if (!current()) return;
        this.platformLive = links.some(link => link.platform === "twitch" && link.account_id === accountId && link.ended_at_ms === null);
        this.sessionId = links.some(link => link.platform === "twitch" &&
          link.account_id === accountId && link.ended_at_ms === null)
          ? String(active!.id) : null;
      }
      if (this.sessionId !== previousSession) this.lastSuccessfulPollAt = null;
      if (!current()) return;
      if (
        this.platformLive && this.sessionId &&
        this.token.scopes.includes("moderator:read:chatters")
      ) {
        const attemptedAtMs = this.now();
        const unobservedFromMs = this.lastSuccessfulPollAt ?? attemptedAtMs;
        try {
          const users: { user_id: string; user_name: string }[] = [];
          const sessionId = this.sessionId;
          const abort = AbortSignal.timeout(30000);
          const poll = await collectChatters(async (cursor) => {
            if (!current()) throw new Error("TWITCH_AUTH_CANCELLED");
            const page = object(
              await this.api(
                `chat/chatters?broadcaster_id=${accountId}&moderator_id=${accountId}&first=1000${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`,
                { signal: abort },
              ),
            ) as unknown as ChattersPage;
            users.push(...page.data);
            return page;
          });
          if (!current()) return;
          // Cover the interval from the previous successful poll (not one minute bucket).
          const windowed = {
            ...poll,
            userNames:Object.fromEntries(users.map(user=>[user.user_id,user.user_name])),
            startedAtMs:
              this.lastSuccessfulPollAt !== null && poll.startedAtMs - this.lastSuccessfulPollAt <= 120000
                ? Math.min(this.lastSuccessfulPollAt, poll.startedAtMs)
                : poll.startedAtMs,
          };
          await this.db.call("recordPoll", sessionId, accountId, windowed);
          if (!current()) return;
          await this.db.call("updateChatterNames", accountId, users, Date.now());
          if (!current()) return;
          this.status.capabilities.presence = poll.status;
          if (poll.status === "complete")
            this.lastSuccessfulPollAt = poll.completedAtMs;
          else {
            this.lastSuccessfulPollAt = null;
            await this.db.call(
              "gap",
              "twitch",
              poll.status === "failed" ? "chatters_poll_failed" : "chatters_poll_incomplete",
              windowed.startedAtMs,
              poll.completedAtMs,
            );
          }
        } catch (error) {
          if (!current()) return;
          this.lastSuccessfulPollAt = null;
          this.status.capabilities.presence =
            error instanceof Error ? error.message : "chatters_error";
          await this.db.call("gap", "twitch", "chatters_poll_failed",
            unobservedFromMs, Math.max(attemptedAtMs, this.now()));
          // Isolate from EventSub — do not rethrow into start()/reconnect.
        }
      }
      if (current() && this.reconcileError !== null) {
        if (this.eventSubReady && this.status.detail === this.reconcileError) {
          this.status.state = "connected";
          this.status.detail = "Сбор событий включён";
        }
        this.reconcileError = null;
      }
    } catch (error) {
      if (current()) this.reconcileError = error instanceof Error ? error.message : "TWITCH_ERROR";
      throw error;
    } finally {
      // A response from an old login must not release a newer login's poll.
      if (this.reconcilingGeneration === generation) this.reconcilingGeneration = null;
      if (current()) {
        const immediate = this.reconcileRequested;
        this.reconcileRequested = false;
        this.tick = setTimeout(() => { this.tick = null; void this.reconcile().catch(error => this.report(error)); }, immediate ? 0 : this.platformLive ? 60000 : 300000);
      }
    }
  }
  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : "TWITCH_ERROR";
    if (message === "TWITCH_REAUTH_REQUIRED") {
      this.status.state = "error";
      this.status.detail = "Требуется повторный вход в Twitch";
      return;
    }
    this.status.state = "degraded";
    this.status.detail = message;
  }
  private scheduleReconnect(): void {
    if (this.stopped || this.retry || !this.config.value.twitch) return;
    const wait =
      Math.min(60000, 1000 * 2 ** Math.min(6, this.reconnectAttempt++)) +
      Math.random() * 1000;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.start();
    }, wait);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.eventSubReady = false;
    this.reconcileError = null;
    ++this.authGeneration;
    for (const timer of [this.retry, this.tick, this.hourly])
      if (timer) clearTimeout(timer);
    this.retry = this.tick = this.hourly = null;
    this.reconcileRequested = false;
    this.lastSuccessfulPollAt = null;
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
    this.socket = null;
  }
  async disconnect(): Promise<void> {
    await this.stop();
    delete this.config.value.twitch;
    this.device = null;
    await this.config.save();
    this.status = {
      state: "disconnected",
      detail: "Не подключён",
      capabilities: {},
    };
  }
}
