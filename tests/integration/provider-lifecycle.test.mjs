import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as turn } from "node:timers/promises";
import {
  TwitchConnection,
  object,
  string,
} from "../../dist/apps/daemon/src/twitch.js";
import { DonationAlertsConnection } from "../../dist/apps/daemon/src/donationalerts.js";
const response = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers });
const flush = async () => {
  for (let i = 0; i < 25; i++) await turn();
};
class Socket extends EventEmitter {
  sent = [];
  closed = false;
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.emit("close");
    }
  }
  terminate() {
    this.close();
  }
  ping() {
    this.emit("pong");
  }
  push(data) {
    this.emit(
      "message",
      Buffer.from(typeof data === "string" ? data : JSON.stringify(data)),
    );
  }
}
function fixture(t) {
  t.mock.timers.enable({
    apis: ["Date", "setTimeout", "setInterval"],
    now: Date.now(),
  });
  const calls = [],
    sockets = [];
  let sessions = [];
  const config = {
    value: {
      twitchClientId: "client123",
      twitch: {
        access: "a",
        refresh: "r",
        expiresAt: Date.now() + 7200000,
        userId: "owner",
        scopes: [],
      },
      daAccessToken: "da",
      daRefreshToken: "refresh",
      daClientId: "app",
      daClientSecret: "secret",
      daUtcOffsetMinutes: null,
      chattersPollSeconds: 60,
      excludedBotLogins: [],
    },
    save: async () => {},
  };
  const db = {
    call: async (method, ...args) => {
      calls.push({ method, args });
      if (method === "sessions") return sessions;
      if (method === "startSession") {
        sessions = [
          {
            id: "session-db",
            account_id: "owner",
            kind: args[3],
            ended_at_ms: null,
          },
        ];
        return "session-db";
      }
      if (method === "endSession") sessions[0].ended_at_ms = args[1];
      return null;
    },
  };
  const socket = (url, options) => {
    assert.equal(options.maxPayload, 1048576);
    const s = new Socket();
    s.url = url;
    sockets.push(s);
    return s;
  };
  return {
    config,
    db,
    calls,
    sockets,
    socket,
    setSessions: (value) => (sessions = value),
    tick: async (ms) => {
      t.mock.timers.tick(ms);
      await flush();
    },
  };
}
const welcome = {
  metadata: { message_type: "session_welcome" },
  payload: { session: { id: "wire", keepalive_timeout_seconds: 60 } },
};
const notification = (type, event = {}) => ({
  metadata: {
    message_type: "notification",
    message_id: "n" + type,
    message_timestamp: new Date().toISOString(),
  },
  payload: { subscription: { type }, event },
});
function twitchRequest(f, options = {}) {
  return async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/device"))
      return response({
        device_code: "device",
        verification_uri: "https://twitch.tv/activate",
        user_code: "CODE",
        expires_in: 60,
        interval: 5,
      });
    if (path.endsWith("/validate"))
      return response({
        client_id: "client123",
        user_id: "owner",
        login: "Owner",
        scopes: options.scopes ?? [
          "user:read:chat",
          "moderator:read:chatters",
          "bits:read",
          "moderator:read:followers",
          "channel:read:subscriptions",
        ],
      });
    if (path.endsWith("/streams"))
      return response({
        data: options.offline
          ? []
          : [
              {
                id: "stream",
                started_at: new Date(Date.now() - 60000).toISOString(),
              },
            ],
      });
    if (path.endsWith("/chatters"))
      return response(
        options.badPoll
          ? { data: [{ user_id: 0 }], pagination: {} }
          : { data: [{ user_id: "42", user_name: "Viewer" }], pagination: {} },
      );
    if (path.endsWith("/subscriptions")) {
      const b = JSON.parse(init.body);
      options.subs?.push(b);
      return response({}, b.type === options.failType ? 403 : 202);
    }
    throw new Error("unexpected " + url);
  };
}
test("Twitch lifecycle: full subscriptions, safe handoff, transient gap, offline confirmation and stop", async (t) => {
  const f = fixture(t),
    subs = [],
    opts = { subs };
  const c = new TwitchConnection(
    f.config,
    f.db,
    twitchRequest(f, opts),
    f.socket,
  );
  try {
    await c.start();
    f.sockets[0].push(welcome);
    await flush();
    assert.equal(c.status.state, "connected");
    assert.equal(subs.length, 12);
    assert.equal(subs.find((x) => x.type === "channel.follow").version, "2");
    f.sockets[0].push({
      metadata: { message_type: "session_reconnect" },
      payload: { session: { reconnect_url: "wss://evil.example/ws" } },
    });
    await flush();
    assert.equal(c.status.detail, "INVALID_RECONNECT_URL");
    assert.equal(f.sockets.length, 1);
    f.sockets[0].push({
      metadata: { message_type: "session_reconnect" },
      payload: {
        session: { reconnect_url: "wss://eventsub.wss.twitch.tv/ws?handoff=1" },
      },
    });
    await flush();
    f.sockets[1].push(welcome);
    await flush();
    assert.equal(f.sockets[0].closed, true);
    assert.equal(subs.length, 12, "handoff must not duplicate subscriptions");
    f.sockets[1].push("invalid json");
    await flush();
    assert.equal(c.status.state, "degraded");
    f.sockets[1].emit("error", new Error("wire"));
    assert.equal(c.status.detail, "Ошибка WebSocket");
    f.sockets[1].close();
    await f.tick(2100);
    assert.equal(f.sockets.length, 3);
    f.sockets[2].push(welcome);
    await flush();
    assert.ok(
      f.calls.some(
        (x) => x.method === "gap" && x.args[1] === "connection_lost_no_replay",
      ),
    );
    assert.equal(c.status.state, "connected");
    opts.offline = true;
    await f.tick(60000);
    assert.equal(f.calls.filter((x) => x.method === "endSession").length, 0);
    await f.tick(60000);
    assert.equal(f.calls.filter((x) => x.method === "endSession").length, 1);
    await c.disconnect();
    assert.equal(c.status.state, "disconnected");
    assert.equal(f.config.value.twitch, undefined);
    await f.tick(3600000);
    assert.equal(f.sockets.length, 3);
  } finally {
    await c.stop();
  }
});
test("Twitch partial poll and optional subscription rejection remain observable; manual session remains open", async (t) => {
  const f = fixture(t);
  f.setSessions([{ id: "manual", kind: "manual", ended_at_ms: null }]);
  const opts = { offline: true, badPoll: true, failType: "channel.cheer" };
  const c = new TwitchConnection(
    f.config,
    f.db,
    twitchRequest(f, opts),
    f.socket,
  );
  try {
    await c.start();
    f.sockets[0].push(welcome);
    await flush();
    assert.equal(c.status.capabilities.presence, "failed");
    assert.equal(c.status.capabilities["channel.cheer"], "TWITCH_HTTP_403");
    assert.ok(
      f.calls.some(
        (x) => x.method === "gap" && x.args[1] === "chatters_poll_incomplete",
      ),
    );
    await f.tick(60000);
    assert.equal(f.calls.filter((x) => x.method === "endSession").length, 0);
    await f.tick(3600000);
    assert.equal(c.status.account, "Owner");
  } finally {
    await c.stop();
  }
});
test("Twitch device authorization: pending, slow down, rotating tokens and successful connection", async (t) => {
  const f = fixture(t);
  let polls = 0;
  const fallback = twitchRequest(f);
  const c = new TwitchConnection(
    f.config,
    f.db,
    async (url, init) => {
      if (url.endsWith("/token")) {
        polls++;
        if (polls === 1)
          return response({ message: "authorization_pending" }, 400);
        if (polls === 2) return response({ message: "slow_down" }, 400);
        assert.equal(
          new URLSearchParams(init.body).get("device_code"),
          "device",
        );
        return response({
          access_token: "new",
          refresh_token: "rotated",
          expires_in: 7200,
          scope: ["user:read:chat"],
        });
      }
      return fallback(url, init);
    },
    f.socket,
  );
  try {
    await c.beginAuth("client123", true);
    assert.equal(c.status.state, "authorizing");
    assert.equal(c.device.userCode, "CODE");
    await f.tick(5000);
    await f.tick(5000);
    assert.equal(polls, 2);
    await f.tick(5000);
    assert.equal(polls, 2);
    await f.tick(5000);
    assert.equal(f.config.value.twitch.access, "new");
    assert.equal(f.config.value.twitch.refresh, "rotated");
    assert.equal(c.device, null);
    assert.equal(f.sockets.length, 1);
  } finally {
    await c.stop();
  }
});
test("Twitch authentication rejects invalid app/device, expires after errors and cancels pending login", async (t) => {
  const f = fixture(t);
  let mode = "http",
    polls = 0;
  const c = new TwitchConnection(
    f.config,
    f.db,
    async (url) => {
      if (url.endsWith("/device")) {
        if (mode === "http") return response({}, 503);
        if (mode === "invalid") return response({});
        return response({ device_code: "x", expires_in: 6, interval: 5 });
      }
      polls++;
      return response({}, 403);
    },
    f.socket,
  );
  await assert.rejects(c.beginAuth("!bad", false), /INVALID_CLIENT_ID/);
  await assert.rejects(
    c.beginAuth("client123", false),
    /TWITCH_DEVICE_HTTP_503/,
  );
  mode = "invalid";
  await assert.rejects(
    c.beginAuth("client123", false),
    /INVALID_DEVICE_RESPONSE/,
  );
  mode = "ok";
  await c.beginAuth("client123", false);
  await f.tick(5000);
  assert.equal(c.status.detail, "TWITCH_AUTH_HTTP_403");
  await f.tick(5000);
  assert.equal(c.status.state, "error");
  assert.equal(c.device, null);
  await c.beginAuth("client123", false);
  await c.disconnect();
  await f.tick(10000);
  assert.equal(polls, 2);
  assert.equal(c.status.state, "disconnected");
});
test("Twitch validate refresh retry, scope failure, fatal subscription and keepalive recovery", async (t) => {
  const f = fixture(t);
  let validations = 0,
    mode = "missing";
  const fallback = twitchRequest(f, { failType: "channel.chat.message" });
  const c = new TwitchConnection(
    f.config,
    f.db,
    async (url, init) => {
      if (url.endsWith("/validate")) {
        validations++;
        if (validations === 1) return response({}, 401);
        return response({
          client_id: "client123",
          user_id: "owner",
          scopes: mode === "missing" ? [] : ["user:read:chat"],
        });
      }
      if (url.endsWith("/token"))
        return response({
          access_token: "rotated",
          refresh_token: "r2",
          expires_in: 7200,
        });
      return fallback(url, init);
    },
    f.socket,
  );
  try {
    await c.start();
    assert.equal(c.status.detail, "MISSING_CHAT_SCOPE");
    assert.equal(f.config.value.twitch.access, "rotated");
    mode = "ok";
    await f.tick(2100);
    assert.equal(f.sockets.length, 1);
    f.sockets[0].push(welcome);
    await flush();
    assert.equal(c.status.detail, "TWITCH_HTTP_403");
    await f.tick(66000);
    assert.equal(f.sockets[0].closed, true);
    await c.stop();
    delete f.config.value.twitch;
    await c.start();
    assert.equal(c.status.state, "disconnected");
    await assert.rejects(c.api("anything"), /TWITCH_LOGIN_REQUIRED/);
    assert.throws(() => object([]), /INVALID_PROVIDER_OBJECT/);
    assert.equal(string(1), "");
  } finally {
    await c.stop();
  }
});
test("Twitch token mismatch and repeat 401 are errors, not empty successful responses", async (t) => {
  const f = fixture(t);
  const c = new TwitchConnection(
    f.config,
    f.db,
    async (url) =>
      url.endsWith("/token")
        ? response({
            access_token: "a2",
            refresh_token: "r2",
            expires_in: 7200,
          })
        : response({}, 401),
    f.socket,
  );
  try {
    await c.start();
    assert.equal(c.status.detail, "TWITCH_TOKEN_MISMATCH");
    await assert.rejects(c.api("streams"), /TWITCH_HTTP_401/);
    f.config.value.twitch.expiresAt = 0;
    await assert.rejects(c.api("streams"), /TWITCH_HTTP_401/);
  } finally {
    await c.stop();
  }
});
function daRequest(f, opts = {}) {
  return async (url, init) => {
    if (url.endsWith("/oauth/token"))
      return response(
        opts.token ?? { access_token: "new-da", refresh_token: "rotated-da" },
      );
    if (url.endsWith("/user/oauth"))
      return response({
        data: { id: 7, name: "Owner", socket_connection_token: "socket" },
      });
    if (url.includes("donations"))
      return response(opts.history ?? { data: [], links: { next: null } });
    if (url.endsWith("/centrifuge/subscribe"))
      return response({
        channels: opts.noChannel
          ? []
          : [{ channel: "$alerts:donation_7", token: "channel" }],
      });
    throw new Error(url);
  };
}
test("DA OAuth state is single use; handshake, history, rate limiting and disconnect lifecycle", async (t) => {
  const f = fixture(t),
    opts = {};
  const c = new DonationAlertsConnection(
    f.config,
    f.db,
    daRequest(f, opts),
    f.socket,
  );
  const url = new URL(c.authUrl("http://local/callback")),
    state = url.searchParams.get("state");
  try {
    await assert.rejects(
      c.finishAuth("code", "wrong", "http://local/callback"),
      /INVALID_OAUTH_STATE/,
    );
    await c.finishAuth("code", state, "http://local/callback");
    assert.equal(f.config.value.daRefreshToken, "rotated-da");
    await assert.rejects(
      c.finishAuth("code", state, "http://local/callback"),
      /INVALID_OAUTH_STATE/,
    );
    const s = f.sockets[0];
    s.emit("open");
    assert.equal(s.sent[0].params.token, "socket");
    await f.tick(1100);
    assert.equal(c.status.state, "degraded");
    s.push({ id: 1, result: { client: "client" } });
    await f.tick(1100);
    assert.equal(s.sent[1].method, 1);
    s.push({ id: 2, result: {} });
    await flush();
    assert.equal(c.status.state, "connected");
    s.push({ error: { code: 109 } });
    await flush();
    assert.equal(c.status.detail, "DA_CENTRIFUGO_ERROR");
    s.emit("error", new Error("socket"));
    assert.equal(c.status.capabilities.realtime, "Ошибка WebSocket");
    s.close();
    await f.tick(30000);
    await f.tick(1100);
    assert.equal(f.sockets.length, 2);
    await c.disconnect();
    assert.equal(f.config.value.daAccessToken, "");
    assert.equal(f.config.value.daRefreshToken, "");
    assert.equal(c.status.state, "disconnected");
    await c.start();
    assert.equal(c.status.state, "disconnected");
  } finally {
    await c.stop();
  }
});
test("DA failed channel authorization preserves REST, missing history metadata fails and queue recovers", async (t) => {
  const f = fixture(t),
    opts = { noChannel: true, history: { data: [], links: { next: null } } };
  const c = new DonationAlertsConnection(
    f.config,
    f.db,
    daRequest(f, opts),
    f.socket,
  );
  try {
    await c.start();
    f.sockets[0].emit("open");
    f.sockets[0].push({ id: 1, result: { client: "client" } });
    await f.tick(1100);
    await f.tick(1100);
    assert.equal(c.status.detail, "DA_CHANNEL_TOKEN_MISSING");
    assert.equal(
      c.status.capabilities.history,
      "Импорт доступных страниц завершён",
    );
    opts.history = { data: null };
    const invalid = assert.rejects(c.scanHistory(), /INVALID_DA_HISTORY/);
    await f.tick(1100);
    await invalid;
    assert.equal(c.status.capabilities.history, "Ошибка импорта");
    opts.history = { data: [] };
    const unknown = assert.rejects(c.scanHistory(), /DA_PAGINATION_UNKNOWN/);
    await f.tick(1100);
    await unknown;
    opts.history = { data: [], links: { next: null } };
    const good = c.scanHistory();
    await f.tick(1100);
    await good;
    assert.equal(
      c.status.capabilities.history,
      "Импорт доступных страниц завершён",
    );
    await f.tick(20000);
    assert.equal(f.sockets[0].closed, true);
    assert.equal(c.status.capabilities.realtime, "отключено");
  } finally {
    await c.stop();
  }
});
test("DA expired/missing app credentials and failed authorization never persist tokens", async (t) => {
  const f = fixture(t);
  f.config.value.daClientSecret = "";
  const c = new DonationAlertsConnection(
    f.config,
    f.db,
    async () => response({}, 400),
    f.socket,
  );
  assert.throws(() => c.authUrl("http://local"), /DA_APP_CREDENTIALS_REQUIRED/);
  f.config.value.daClientSecret = "secret";
  let state = new URL(c.authUrl("http://local")).searchParams.get("state");
  await f.tick(600001);
  await assert.rejects(
    c.finishAuth("code", state, "http://local"),
    /INVALID_OAUTH_STATE/,
  );
  state = new URL(c.authUrl("http://local")).searchParams.get("state");
  await assert.rejects(
    c.finishAuth("code", state, "http://local"),
    /DA_OAUTH_HTTP_400/,
  );
  assert.equal(f.config.value.daAccessToken, "da");
  await c.stop();
});
test("DA API retries rotated token once, reports 429/403 and requires refresh credentials", async (t) => {
  const f = fixture(t);
  let mode = "401",
    requests = 0;
  const c = new DonationAlertsConnection(
    f.config,
    f.db,
    async (url, init) => {
      if (url.endsWith("/oauth/token"))
        return response({
          access_token: "rotated",
          refresh_token: "rotated-refresh",
        });
      requests++;
      if (mode === "401" && requests === 1) return response({}, 401);
      if (mode === "429") return response({}, 429, { "retry-after": "1" });
      if (mode === "403") return response({}, 403);
      return response({
        data: { id: 7, name: "Owner", socket_connection_token: "socket" },
      });
    },
    f.socket,
  );
  try {
    const starting = c.start();
    await flush();
    await f.tick(1100);
    await starting;
    assert.equal(f.config.value.daAccessToken, "rotated");
    mode = "429";
    await f.tick(1100);
    assert.equal(c.status.detail, "DA_RATE_LIMIT");
    await c.stop();
    mode = "403";
    const forbidden = c.start();
    await flush();
    await f.tick(2100);
    await forbidden;
    assert.equal(c.status.detail, "DA_HTTP_403");
    await c.stop();
    mode = "401";
    requests = 0;
    f.config.value.daRefreshToken = "";
    const missing = c.start();
    await flush();
    await f.tick(1100);
    await missing;
    assert.equal(c.status.detail, "DA_LOGIN_REQUIRED");
  } finally {
    await c.stop();
  }
});
test("logout invalidates an in-flight Twitch device request and DA authorization-code exchange", async (t) => {
  const f = fixture(t);
  let resolveDevice;
  const twitch = new TwitchConnection(
    f.config,
    f.db,
    () => new Promise((r) => (resolveDevice = r)),
    f.socket,
  );
  const pending = assert.rejects(
    twitch.beginAuth("client123", false),
    /TWITCH_AUTH_CANCELLED/,
  );
  await flush();
  await twitch.disconnect();
  resolveDevice(
    response({
      device_code: "d",
      expires_in: 600,
      interval: 5,
      user_code: "CODE",
    }),
  );
  await pending;
  assert.equal(twitch.status.state, "disconnected");
  assert.equal(twitch.device, null);
  let resolveToken;
  const da = new DonationAlertsConnection(
    f.config,
    f.db,
    () => new Promise((r) => (resolveToken = r)),
    f.socket,
  );
  const state = new URL(da.authUrl("http://local")).searchParams.get("state");
  const auth = assert.rejects(
    da.finishAuth("code", state, "http://local"),
    /DA_AUTH_CANCELLED/,
  );
  await flush();
  await da.disconnect();
  resolveToken(
    response({ access_token: "late-secret", refresh_token: "late-refresh" }),
  );
  await auth;
  assert.equal(f.config.value.daAccessToken, "");
  assert.equal(f.config.value.daRefreshToken, "");
  assert.equal(da.status.state, "disconnected");
  assert.equal(f.sockets.length, 0);
});
test("DA logout invalidates an authorization link before its callback arrives", async (t) => {
  const f = fixture(t);
  let requests = 0;
  const c = new DonationAlertsConnection(
    f.config,
    f.db,
    async () => {
      requests++;
      return response({ access_token: "late", refresh_token: "late" });
    },
    f.socket,
  );
  const state = new URL(c.authUrl("http://local")).searchParams.get("state");
  try {
    await c.disconnect();
    await assert.rejects(
      c.finishAuth("code", state, "http://local"),
      /INVALID_OAUTH_STATE/,
    );
    assert.equal(requests, 0);
    assert.equal(f.config.value.daAccessToken, "");
  } finally {
    await c.stop();
  }
});
test("disconnect during startup validation/refresh preserves disconnected status and empty credentials", async (t) => {
  const f = fixture(t);
  let validate;
  const twitch = new TwitchConnection(
    f.config,
    f.db,
    () => new Promise((r) => (validate = r)),
    f.socket,
  );
  const starting = twitch.start();
  await flush();
  await twitch.disconnect();
  validate(
    response({
      client_id: "client123",
      user_id: "owner",
      scopes: ["user:read:chat"],
    }),
  );
  await starting;
  assert.equal(twitch.status.state, "disconnected");
  assert.equal(f.config.value.twitch, undefined);
  let refresh;
  const da = new DonationAlertsConnection(
    f.config,
    f.db,
    async (url) =>
      url.endsWith("/oauth/token")
        ? new Promise((r) => (refresh = r))
        : response({}, 401),
    f.socket,
  );
  const connecting = da.start();
  await flush();
  await da.disconnect();
  refresh(response({ access_token: "late", refresh_token: "late" }));
  await connecting;
  assert.equal(da.status.state, "disconnected");
  assert.equal(f.config.value.daAccessToken, "");
  assert.equal(f.config.value.daRefreshToken, "");
  assert.equal(f.sockets.length, 0);
});
test("a refresh response from the previous login cannot overwrite a new device login", async (t) => {
  const f = fixture(t);
  let oldResponse;
  const fallback = twitchRequest(f);
  const c = new TwitchConnection(
    f.config,
    f.db,
    async (url, init) => {
      if (url.endsWith("/token")) {
        const grant = new URLSearchParams(init.body).get("grant_type");
        if (grant === "refresh_token")
          return new Promise((resolve) => (oldResponse = resolve));
        return response({
          access_token: "new-login-access",
          refresh_token: "new-login-refresh",
          expires_in: 7200,
          scope: ["user:read:chat"],
        });
      }
      return fallback(url, init);
    },
    f.socket,
  );
  try {
    const stale = assert.rejects(c.refresh(), /TWITCH_AUTH_CANCELLED/);
    await flush();
    await c.disconnect();
    await c.beginAuth("client123", false);
    await f.tick(5000);
    assert.equal(f.config.value.twitch.access, "new-login-access");
    oldResponse(
      response({
        access_token: "old-login-access",
        refresh_token: "old-login-refresh",
        expires_in: 7200,
      }),
    );
    await stale;
    assert.equal(f.config.value.twitch.access, "new-login-access");
    assert.equal(f.config.value.twitch.refresh, "new-login-refresh");
  } finally {
    await c.stop();
  }
});
test("a stream poll from the previous account is never applied to the new login", async (t) => {
  const f = fixture(t);
  let oldStream;
  let streams = 0;
  const fallback = twitchRequest(f);
  const c = new TwitchConnection(
    f.config,
    f.db,
    async (url, init) => {
      if (url.endsWith("/validate"))
        return response({
          client_id: "client123",
          user_id: f.config.value.twitch.userId,
          scopes: ["user:read:chat"],
        });
      if (new URL(url).pathname.endsWith("/streams")) {
        if (++streams === 1)
          return new Promise((resolve) => (oldStream = resolve));
        return response({
          data: [{ id: "new-stream", started_at: new Date().toISOString() }],
        });
      }
      return fallback(url, init);
    },
    f.socket,
  );
  try {
    const starting = c.start();
    await flush();
    const token = { ...f.config.value.twitch };
    await c.disconnect();
    f.config.value.twitch = {
      ...token,
      userId: "new-owner",
      access: "new-access",
    };
    await c.start();
    oldStream(
      response({
        data: [{ id: "old-stream", started_at: new Date().toISOString() }],
      }),
    );
    await starting;
    assert.equal(
      f.calls.filter((x) => x.method === "startSession").length,
      0,
      "a cancelled response must not attach the old stream to the new owner",
    );
    f.sockets.at(-1).push(welcome);
    await flush();
    await f.tick(60000);
    const sessions = f.calls.filter((x) => x.method === "startSession");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].args[0], "new-owner");
    assert.equal(sessions[0].args[1], "new-stream");
  } finally {
    await c.stop();
  }
});

test("a validation response from the previous account cannot mutate or reconnect a new login", async (t) => {
  const f = fixture(t);
  let oldValidate;
  let validations = 0;
  const fallback = twitchRequest(f);
  const c = new TwitchConnection(
    f.config,
    f.db,
    async (url, init) => {
      if (url.endsWith("/validate")) {
        if (++validations === 1)
          return new Promise((resolve) => (oldValidate = resolve));
        return response({
          client_id: "client123",
          user_id: "new-owner",
          login: "New owner",
          scopes: ["user:read:chat"],
        });
      }
      return fallback(url, init);
    },
    f.socket,
  );
  try {
    const starting = c.start();
    await flush();
    const token = { ...f.config.value.twitch };
    await c.disconnect();
    f.config.value.twitch = {
      ...token,
      userId: "new-owner",
      access: "new-access",
    };
    await c.start();
    assert.equal(f.sockets.length, 1);
    oldValidate(
      response({
        client_id: "client123",
        user_id: "old-owner",
        login: "Old owner",
        scopes: ["user:read:chat"],
      }),
    );
    await starting;
    assert.equal(f.config.value.twitch.userId, "new-owner");
    assert.equal(f.config.value.twitch.access, "new-access");
    assert.equal(c.status.account, "New owner");
    assert.equal(
      f.sockets.length,
      1,
      "cancelled validation must not create a second connection",
    );
  } finally {
    await c.stop();
  }
});
