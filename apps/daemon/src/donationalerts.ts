import WebSocket from "ws";
import { parse } from "lossless-json";
import { randomBytes } from "node:crypto";
import type { Configuration } from "./config.js";
import type { StoreClient } from "./db.js";
import {
  moneyToMinor,
  type EventInput,
} from "../../../packages/core/src/domain.js";
import {
  object,
  string,
  type ConnectionStatus,
  type SocketFactory,
} from "./twitch.js";

export function parseDonationTime(
  raw: string,
  offsetMinutes: number | null,
): number | null {
  if (offsetMinutes === null) return null;
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 840)
    throw new Error("INVALID_UTC_OFFSET");
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (!m) throw new Error("INVALID_DA_TIME");
  const d = new Date(
    Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]),
    ),
  );
  if (d.toISOString().slice(0, 19).replace("T", " ") !== raw)
    throw new Error("INVALID_DA_DATE");
  return d.getTime() - offsetMinutes * 60000;
}
export function normalizeDonation(
  raw: unknown,
  accountId: string,
  transport: "rest" | "centrifugo",
  offsetMinutes: number | null,
): EventInput {
  const data = object(raw),
    id = String(data.id ?? "");
  if (!/^[0-9]+$/.test(id)) throw new Error("INVALID_DONATION_ID");
  const amount = moneyToMinor(String(data.amount ?? ""), string(data.currency));
  const name = string(data.username),
    sourceTime = string(data.created_at);
  const occurredAtMs = parseDonationTime(sourceTime, offsetMinutes);
  return {
    source: "donationalerts",
    accountId,
    externalId: id,
    type: "donation",
    actor: name.trim() ? { externalId: id, displayName: name } : null,
    occurredAtMs,
    receivedAtMs: Date.now(),
    sourceTime,
    timeQuality: occurredAtMs === null ? "unknown" : "configured",
    transport,
    payload: {
      amountMinor: amount,
      currency: string(data.currency),
      text: string(data.message),
      actorName: name,
      messageType: string(data.message_type),
    },
  };
}
// Published legacy frames wrap the resource in result/data. Ignore unrelated push types.
export function findDonation(value: unknown, depth = 0): unknown | null {
  if (depth > 6 || !value || typeof value !== "object" || Array.isArray(value))
    return null;
  const row = value as Record<string, unknown>;
  if (
    row.id !== undefined &&
    row.amount !== undefined &&
    row.currency !== undefined &&
    row.created_at !== undefined
  )
    return row;
  for (const key of ["result", "data", "publication"]) {
    const found = findDonation(row[key], depth + 1);
    if (found) return found;
  }
  return null;
}

export class DonationAlertsConnection {
  status: ConnectionStatus = {
    state: "disconnected",
    detail: "Не подключён",
    capabilities: {},
  };
  private stopped = true;
  private socket: WebSocket | null = null;
  private retry: NodeJS.Timeout | null = null;
  private history: NodeJS.Timeout | null = null;
  private scanning = false;
  private recipient = "";
  private generation = 0;
  private httpTail = Promise.resolve();
  private lastRequest = 0;
  private refreshPromise: Promise<void> | null = null;
  private oauthState: { value: string; expiresAt: number } | null = null;
  constructor(
    private config: Configuration,
    private db: StoreClient,
    private request: typeof fetch = fetch,
    private socketFactory: SocketFactory = (url, options) =>
      new WebSocket(url, options),
  ) {}
  authUrl(callback: string): string {
    if (!this.config.value.daClientId || !this.config.value.daClientSecret)
      throw new Error("DA_APP_CREDENTIALS_REQUIRED");
    this.oauthState = {
      value: randomBytes(32).toString("hex"),
      expiresAt: Date.now() + 600000,
    };
    const parameters = new URLSearchParams({
      client_id: this.config.value.daClientId,
      redirect_uri: callback,
      response_type: "code",
      scope: "oauth-user-show oauth-donation-subscribe oauth-donation-index",
      state: this.oauthState.value,
    });
    return `https://www.donationalerts.com/oauth/authorize?${parameters}`;
  }
  async finishAuth(
    code: string,
    state: string,
    callback: string,
  ): Promise<void> {
    if (
      !this.oauthState ||
      this.oauthState.value !== state ||
      this.oauthState.expiresAt < Date.now()
    )
      throw new Error("INVALID_OAUTH_STATE");
    this.oauthState = null;
    const generation = this.generation;
    const response = await this.request(
      "https://www.donationalerts.com/oauth/token",
      {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: this.config.value.daClientId,
          client_secret: this.config.value.daClientSecret,
          redirect_uri: callback,
          code,
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const body = object(await response.json());
    if (generation !== this.generation) throw new Error("DA_AUTH_CANCELLED");
    if (!response.ok || !string(body.access_token))
      throw new Error(`DA_OAUTH_HTTP_${response.status}`);
    this.config.value.daAccessToken = string(body.access_token);
    this.config.value.daRefreshToken = string(body.refresh_token);
    await this.config.save();
    if (generation !== this.generation) throw new Error("DA_AUTH_CANCELLED");
    await this.start();
  }
  private async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const generation = this.generation;
    this.refreshPromise = (async () => {
      const c = this.config.value;
      if (!c.daRefreshToken || !c.daClientId || !c.daClientSecret)
        throw new Error("DA_LOGIN_REQUIRED");
      const response = await this.request(
        "https://www.donationalerts.com/oauth/token",
        {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: c.daRefreshToken,
            client_id: c.daClientId,
            client_secret: c.daClientSecret,
            scope:
              "oauth-user-show oauth-donation-subscribe oauth-donation-index",
          }),
          signal: AbortSignal.timeout(15000),
        },
      );
      const body = object(await response.json());
      if (generation !== this.generation) throw new Error("DA_AUTH_CANCELLED");
      if (!response.ok) throw new Error("DA_REAUTH_REQUIRED");
      c.daAccessToken = string(body.access_token);
      if (string(body.refresh_token))
        c.daRefreshToken = string(body.refresh_token);
      await this.config.save();
    })();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }
  private async api(
    path: string,
    init: RequestInit = {},
    retried = false,
  ): Promise<unknown> {
    const task = this.httpTail.then(async () => {
      const wait = 1100 - (Date.now() - this.lastRequest);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastRequest = Date.now();
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${this.config.value.daAccessToken}`);
      return this.request(`https://www.donationalerts.com/api/v1/${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(15000),
      });
    });
    this.httpTail = task.then(
      () => {},
      () => {},
    );
    const response = await task;
    if (response.status === 401 && !retried) {
      await this.refresh();
      return this.api(path, init, true);
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after")) || 60;
      this.lastRequest = Date.now() + seconds * 1000;
      throw new Error("DA_RATE_LIMIT");
    }
    if (!response.ok) throw new Error(`DA_HTTP_${response.status}`);
    return parse(await response.text());
  }
  async start(): Promise<void> {
    await this.stop();
    if (!this.config.value.daAccessToken) {
      this.status = {
        state: "disconnected",
        detail: "Не подключён",
        capabilities: {},
      };
      return;
    }
    this.stopped = false;
    const generation = this.generation;
    this.status.state = "connecting";
    this.status.detail = "Подключение…";
    try {
      const profile = object(object(await this.api("user/oauth")).data);
      if (this.stopped || generation !== this.generation) return;
      this.recipient = String(profile.id);
      this.status.account = string(profile.name);
      this.connect(string(profile.socket_connection_token), generation);
      // REST remains useful if realtime permission/protocol fails. State exposes each capability.
      void this.scanHistory().catch((error) => this.report(error));
      this.history = setInterval(() => {
        void this.scanHistory().catch((error) => this.report(error));
      }, 300000);
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      this.report(error);
      this.schedule();
    }
  }
  private connect(token: string, generation: number): void {
    const socket = this.socketFactory(
      "wss://centrifugo.donationalerts.com/connection/websocket",
      { maxPayload: 1048576 },
    );
    this.socket = socket;
    const deadline = setTimeout(() => {
      this.status.capabilities.realtime = "Handshake timeout";
      socket.terminate();
    }, 20000);
    let subscribed = false;
    socket.on("open", () =>
      socket.send(JSON.stringify({ params: { token }, id: 1 })),
    );
    socket.on("message", (frame) => {
      void (async () => {
        if (this.stopped || generation !== this.generation) return;
        for (const line of frame.toString().split("\n").filter(Boolean)) {
          const message = object(parse(line));
          if (message.error) throw new Error("DA_CENTRIFUGO_ERROR");
          const result =
            message.result && typeof message.result === "object"
              ? object(message.result)
              : {};
          if (result.client && !subscribed) {
            const channel = `$alerts:donation_${this.recipient}`;
            const response = object(
              await this.api("centrifuge/subscribe", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  channels: [channel],
                  client: string(result.client),
                }),
              }),
            );
            const subscriptions = Array.isArray(response.channels)
              ? response.channels
              : [];
            const selected = subscriptions
              .map(object)
              .find((row) => row.channel === channel);
            if (!selected) throw new Error("DA_CHANNEL_TOKEN_MISSING");
            subscribed = true;
            socket.send(
              JSON.stringify({
                params: { channel, token: string(selected.token) },
                method: 1,
                id: 2,
              }),
            );
          } else if (
            subscribed &&
            ((result.type !== undefined && String(result.type) === "1") ||
              String(message.id) === "2")
          ) {
            clearTimeout(deadline);
            this.status.capabilities.realtime = "connected";
            this.status.state = "connected";
            this.status.detail = "Сбор донатов включён";
          }
          const donation = findDonation(message);
          if (donation) {
            await this.db.call(
              "ingest",
              normalizeDonation(
                donation,
                this.recipient,
                "centrifugo",
                this.config.value.daUtcOffsetMinutes,
              ),
            );
            this.status.lastEventAt = Date.now();
          }
        }
      })().catch((error) => this.report(error));
    });
    socket.on("close", () => {
      clearTimeout(deadline);
      if (!this.stopped && generation === this.generation) {
        this.status.capabilities.realtime = "disconnected";
        this.schedule();
      }
    });
    socket.on("error", () => {
      this.status.capabilities.realtime = "WebSocket error";
    });
  }
  async scanHistory(): Promise<void> {
    if (this.scanning || this.stopped) return;
    this.scanning = true;
    const generation = this.generation;
    this.status.capabilities.history = "Импорт…";
    try {
      let complete = false;
      for (
        let page = 1;
        page <= 1000 && !this.stopped && generation === this.generation;
        page++
      ) {
        const response = object(
          await this.api(`alerts/donations?page=${page}`),
        );
        if (this.stopped || generation !== this.generation) return;
        if (!Array.isArray(response.data))
          throw new Error("INVALID_DA_HISTORY");
        for (const raw of response.data)
          await this.db.call(
            "ingest",
            normalizeDonation(
              raw,
              this.recipient,
              "rest",
              this.config.value.daUtcOffsetMinutes,
            ),
          );
        const links = response.links ? object(response.links) : {};
        if (links.next === null) {
          complete = true;
          break;
        }
        if (!string(links.next)) throw new Error("DA_PAGINATION_UNKNOWN");
      }
      this.status.capabilities.history = complete
        ? "Импорт доступных страниц завершён"
        : "Импорт неполный (лимит/остановка)";
      if (this.status.state !== "connected") {
        this.status.state = "degraded";
        this.status.detail = "REST работает; realtime не подтверждён";
      }
    } catch (error) {
      this.status.capabilities.history = "Ошибка импорта";
      throw error;
    } finally {
      this.scanning = false;
    }
  }
  private report(error: unknown): void {
    this.status.state = "degraded";
    this.status.detail = error instanceof Error ? error.message : "DA_ERROR";
  }
  private schedule(): void {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.start();
    }, 30000);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.oauthState = null;
    ++this.generation;
    if (this.retry) clearTimeout(this.retry);
    if (this.history) clearInterval(this.history);
    this.retry = this.history = null;
    this.socket?.close();
    this.socket = null;
  }
  async disconnect(): Promise<void> {
    await this.stop();
    this.config.value.daAccessToken = "";
    this.config.value.daRefreshToken = "";
    await this.config.save();
    this.status = {
      state: "disconnected",
      detail: "Не подключён",
      capabilities: {},
    };
  }
}
