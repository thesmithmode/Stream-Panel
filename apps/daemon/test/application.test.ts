import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "lossless-json";
import { createApplication } from "../src/server.js";
import {
  normalizeDonation,
  parseDonationTime,
  findDonation,
} from "../src/donationalerts.js";
import { normalizeTwitch } from "../src/twitch.js";
import { Configuration } from "../src/config.js";

const chatEnvelope = {
  metadata: {
    message_type: "notification",
    message_id: "envelope-id",
    message_timestamp: "2026-10-06T20:00:00.123456789Z",
  },
  payload: {
    subscription: { type: "channel.chat.message" },
    event: {
      message_id: "original-id",
      chatter_user_id: "42",
      chatter_user_name: "Alice",
      message: { text: "hello" },
      source_broadcaster_user_id: null,
    },
  },
};
test("documented Twitch chat IDs and UTC nanoseconds normalize without using envelope ID for dedupe", () => {
  const event = normalizeTwitch(chatEnvelope, "channel")!;
  assert.equal(event.externalId, "original-id");
  assert.equal(event.occurredAtMs, 1791316800123);
  assert.equal(event.actor!.externalId, "42");
  assert.equal(event.sourceTime, "2026-10-06T20:00:00.123456789Z");
});
test("channel.subscription.message extracts text from message object", () => {
  const event = normalizeTwitch(
    {
      metadata: {
        message_type: "notification",
        message_id: "sub-msg-id",
        message_timestamp: "2026-10-06T20:00:00.000Z",
      },
      payload: {
        subscription: { type: "channel.subscription.message" },
        event: {
          user_id: "99",
          user_name: "Bob",
          message: { text: "Love the stream!", emotes: null },
          cumulative_months: 3,
        },
      },
    },
    "channel",
  )!;
  assert.equal(event.type, "subscription.message");
  assert.equal(event.payload.text, "Love the stream!");
});

test("lossless DA money and recipient are normalized; missing timezone stays unknown", () => {
  const raw = parse(
    '{"id":9007199254740993,"amount":0.29,"currency":"RUB","username":"Alice","message":"hello","created_at":"2026-10-06 20:00:00"}',
  );
  const event = normalizeDonation(raw, "recipient", "rest", null);
  assert.equal(event.externalId, "9007199254740993");
  assert.equal(event.payload.amountMinor, "29");
  assert.equal(event.occurredAtMs, null);
  assert.equal(event.timeQuality, "unknown");
  assert.equal(event.actor!.externalId, event.externalId);
  assert.equal(findDonation({ result: { data: raw } }), raw);
});
test("manual DA source offset is explicit and invalid calendar dates fail closed", () => {
  assert.equal(
    parseDonationTime("2026-10-06 23:00:00", 180),
    Date.parse("2026-10-06T20:00:00Z"),
  );
  assert.throws(
    () => parseDonationTime("2026-02-30 10:00:00", 0),
    /INVALID_DA_DATE/,
  );
  assert.throws(
    () => parseDonationTime("2026-10-06 20:00:00", 1000),
    /INVALID_UTC_OFFSET/,
  );
});
test("concurrent secret persistence is serialized and public config never includes tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stream-panel-config-"));
  try {
    const config = new Configuration(directory);
    await config.load();
    config.value.daAccessToken = "private-token";
    const a = config.save();
    config.value.daClientId = "app-id";
    const b = config.save();
    await Promise.all([a, b]);
    const saved = JSON.parse(
      await readFile(join(directory, "secrets.json"), "utf8"),
    );
    assert.equal(saved.daClientId, "app-id");
    assert.equal(
      JSON.stringify(config.publicView()).includes("private-token"),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("local API requires bootstrap; rejects cross-site reads, Host rebinding, CSRF and nonce reuse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stream-panel-http-"));
  const application = await createApplication(directory, 47831, false);
  const headers = { host: "127.0.0.1:47831" };
  try {
    const unauthorized = await application.app.inject({
      method: "GET",
      url: "/api/v1/persons",
      headers,
    });
    assert.equal(unauthorized.statusCode, 401);
    const key = new URLSearchParams(application.bootstrap().split("#")[1]).get(
      "key",
    )!;
    const login = await application.app.inject({
      method: "POST",
      url: "/api/v1/bootstrap",
      headers,
      payload: { key },
    });
    assert.equal(login.statusCode, 200);
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const csrf = login.json().csrf;
    const reused = await application.app.inject({
      method: "POST",
      url: "/api/v1/bootstrap",
      headers,
      payload: { key },
    });
    assert.equal(reused.statusCode, 401);
    const cross = await application.app.inject({
      method: "GET",
      url: "/api/v1/persons",
      headers: { ...headers, cookie, origin: "https://evil.example" },
    });
    assert.equal(cross.statusCode, 403);
    const rebinding = await application.app.inject({
      method: "GET",
      url: "/api/v1/persons",
      headers: { host: "evil.example", cookie },
    });
    assert.equal(rebinding.statusCode, 403);
    const csrfMissing = await application.app.inject({
      method: "POST",
      url: "/api/v1/sessions/start",
      headers: { ...headers, cookie },
      payload: {},
    });
    assert.equal(csrfMissing.statusCode, 403);
    const authorized = await application.app.inject({
      method: "POST",
      url: "/api/v1/sessions/start",
      headers: { ...headers, cookie, "x-csrf-token": csrf },
      payload: {},
    });
    assert.equal(authorized.statusCode, 200);
    const sessionId = authorized.json().id;
    const duplicate = await application.app.inject({
      method: "POST",
      url: "/api/v1/sessions/start",
      headers: { ...headers, cookie, "x-csrf-token": csrf },
      payload: {},
    });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    await application.db.call("ingest", {
      ...normalizeTwitch(chatEnvelope, "channel")!,
      occurredAtMs: Date.now(),
      receivedAtMs: Date.now(),
    });
    const summary = await application.app.inject({
      method: "GET",
      url: `/api/v1/summary?session=${sessionId}`,
      headers: { ...headers, cookie },
    });
    assert.equal(summary.json().messages, 1);
    const config = await application.app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: { ...headers, cookie },
    });
    assert.equal(config.json().config.daClientSecret, undefined);
  } finally {
    await application.app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("chat moderation redacts persisted text rather than hiding it only in UI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stream-panel-redaction-"));
  const app = await createApplication(directory, 47831, false);
  try {
    await app.db.call("ingest", normalizeTwitch(chatEnvelope, "channel"));
    const deletion = {
      metadata: {
        message_type: "notification",
        message_id: "delete-id",
        message_timestamp: "2026-10-06T20:01:00Z",
      },
      payload: {
        subscription: { type: "channel.chat.message_delete" },
        event: { message_id: "original-id" },
      },
    };
    await app.db.call("ingest", normalizeTwitch(deletion, "channel"));
    const events = await app.db.call<any[]>("events");
    const chat = events.find((e) => e.type === "chat.message").payload;
    assert.equal(chat.text, "hello", "moderation must not overwrite text");
    assert.equal(chat.redacted, 1);
  } finally {
    await app.app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Twitch rotating refresh is single-flight and public clients never send client_secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stream-panel-refresh-"));
  const config = new Configuration(directory);
  await config.load();
  config.value.twitchClientId = "public-client";
  config.value.twitch = {
    access: "old-access",
    refresh: "one-use-refresh",
    expiresAt: 0,
    userId: "42",
    scopes: [],
  };
  let calls = 0;
  const request = (async (_url: unknown, init?: RequestInit) => {
    calls++;
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.has("client_secret"), false);
    assert.equal(body.get("refresh_token"), "one-use-refresh");
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(
      JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
    );
  }) as typeof fetch;
  const { TwitchConnection } = await import("../src/twitch.js");
  const connection = new TwitchConnection(config, null as never, request);
  try {
    await Promise.all([connection.refresh(), connection.refresh()]);
    assert.equal(calls, 1);
    assert.equal(config.value.twitch.refresh, "new-refresh");
    assert.equal(
      JSON.parse(await readFile(join(directory, "secrets.json"), "utf8")).twitch
        .refresh,
      "new-refresh",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Twitch refresh keeps previous refresh_token when provider omits it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stream-panel-refresh-omit-"));
  const config = new Configuration(directory);
  await config.load();
  config.value.twitchClientId = "public-client";
  config.value.twitch = {
    access: "old-access",
    refresh: "keep-me",
    expiresAt: 0,
    userId: "42",
    scopes: [],
  };
  const request = (async () =>
    new Response(
      JSON.stringify({
        access_token: "new-access",
        expires_in: 3600,
      }),
    )) as typeof fetch;
  const { TwitchConnection } = await import("../src/twitch.js");
  const connection = new TwitchConnection(config, null as never, request);
  try {
    await connection.refresh();
    assert.equal(config.value.twitch.refresh, "keep-me");
    assert.equal(config.value.twitch.access, "new-access");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Twitch blocks new Helix requests until a 429 reset boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stream-panel-rate-"));
  const config = new Configuration(directory);
  await config.load();
  config.value.twitch = {
    access: "token",
    refresh: "refresh",
    expiresAt: Date.now() + 3600000,
    userId: "42",
    scopes: [],
  };
  let calls = 0;
  const request = (async () => {
    calls++;
    return new Response("{}", {
      status: 429,
      headers: {
        "ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 120),
      },
    });
  }) as typeof fetch;
  const { TwitchConnection } = await import("../src/twitch.js");
  const connection = new TwitchConnection(config, null as never, request);
  try {
    await assert.rejects(connection.api("streams"), /TWITCH_RATE_LIMIT_UNTIL/);
    await assert.rejects(connection.api("streams"), /TWITCH_RATE_LIMIT_UNTIL/);
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DA OAuth refuses missing or mismatched state before exchanging any authorization code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stream-panel-state-"));
  const config = new Configuration(directory);
  await config.load();
  config.value.daClientId = "own-app";
  config.value.daClientSecret = "own-secret";
  let calls = 0;
  const request = (async () => {
    calls++;
    return new Response("{}");
  }) as typeof fetch;
  const { DonationAlertsConnection } = await import("../src/donationalerts.js");
  const connection = new DonationAlertsConnection(
    config,
    null as never,
    request,
  );
  try {
    const url = new URL(
      connection.authUrl(
        "http://localhost:47831/oauth/donationalerts/callback",
      ),
    );
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.ok(url.searchParams.get("state"));
    await assert.rejects(
      connection.finishAuth("code", "", "callback"),
      /INVALID_OAUTH_STATE/,
    );
    await assert.rejects(
      connection.finishAuth("code", "other", "callback"),
      /INVALID_OAUTH_STATE/,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired Twitch refresh clears credentials and sets reauth state without looping", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stream-panel-reauth-"));
  const config = new Configuration(directory);
  await config.load();
  config.value.twitchClientId = "public-client";
  config.value.twitch = {
    access: "old-access",
    refresh: "dead-refresh",
    expiresAt: 0,
    userId: "42",
    scopes: [],
  };
  const request = (async () =>
    new Response(JSON.stringify({ status: "invalid" }), {
      status: 400,
    })) as typeof fetch;
  const { TwitchConnection } = await import("../src/twitch.js");
  const connection = new TwitchConnection(config, null as never, request);
  try {
    await assert.rejects(connection.refresh(), /TWITCH_REAUTH_REQUIRED/);
    assert.equal(config.value.twitch, undefined);
    assert.equal(connection.status.state, "error");
    assert.match(connection.status.detail, /повторный вход/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Twitch refresh invalid_grant clears credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stream-panel-reauth-ig-"));
  const config = new Configuration(directory);
  await config.load();
  config.value.twitchClientId = "public-client";
  config.value.twitch = {
    access: "old-access",
    refresh: "dead-refresh",
    expiresAt: 0,
    userId: "42",
    scopes: [],
  };
  const request = (async () =>
    new Response(
      JSON.stringify({ error: "invalid_grant", message: "Invalid refresh token" }),
      { status: 400 },
    )) as typeof fetch;
  const { TwitchConnection } = await import("../src/twitch.js");
  const connection = new TwitchConnection(config, null as never, request);
  try {
    await assert.rejects(connection.refresh(), /TWITCH_REAUTH_REQUIRED/);
    assert.equal(config.value.twitch, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Twitch refresh 503 retains tokens for backoff retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stream-panel-refresh-503-"));
  const config = new Configuration(directory);
  await config.load();
  config.value.twitchClientId = "public-client";
  config.value.twitch = {
    access: "old-access",
    refresh: "keep-refresh",
    expiresAt: 0,
    userId: "42",
    scopes: [],
  };
  const request = (async () =>
    new Response("upstream unavailable", { status: 503 })) as typeof fetch;
  const { TwitchConnection } = await import("../src/twitch.js");
  const connection = new TwitchConnection(config, null as never, request);
  try {
    await assert.rejects(connection.refresh(), /TWITCH_REFRESH_HTTP_503/);
    assert.equal(config.value.twitch?.refresh, "keep-refresh");
    assert.equal(config.value.twitch?.access, "old-access");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Twitch refresh 429 retains tokens for backoff retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stream-panel-refresh-429-"));
  const config = new Configuration(directory);
  await config.load();
  config.value.twitchClientId = "public-client";
  config.value.twitch = {
    access: "old-access",
    refresh: "keep-refresh",
    expiresAt: 0,
    userId: "42",
    scopes: [],
  };
  const request = (async () =>
    new Response(JSON.stringify({ message: "slow down" }), {
      status: 429,
    })) as typeof fetch;
  const { TwitchConnection } = await import("../src/twitch.js");
  const connection = new TwitchConnection(config, null as never, request);
  try {
    await assert.rejects(connection.refresh(), /TWITCH_REFRESH_HTTP_429/);
    assert.equal(config.value.twitch?.refresh, "keep-refresh");
    assert.equal(config.value.twitch?.access, "old-access");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
