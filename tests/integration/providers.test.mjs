import test from "node:test";
import assert from "node:assert/strict";
import { TwitchConnection } from "../../dist/apps/daemon/src/twitch.js";
import { DonationAlertsConnection } from "../../dist/apps/daemon/src/donationalerts.js";
import { until, provider, database } from "../helpers/provider.mjs";
const chat = (id = "message") => ({
  metadata: {
    message_type: "notification",
    message_id: "envelope-" + id,
    message_timestamp: new Date().toISOString(),
  },
  payload: {
    subscription: { type: "channel.chat.message" },
    event: {
      message_id: id,
      chatter_user_id: "42",
      chatter_user_name: "Viewer",
      message: { text: "wire message" },
    },
  },
});
const welcome = (id = "session") => ({
  metadata: { message_type: "session_welcome" },
  payload: { session: { id, keepalive_timeout_seconds: 30 } },
});
test(
  "Twitch contract: real HTTP/WS -> subscriptions, paginated presence, dedupe and revocation",
  { timeout: 15000 },
  async () => {
    const f = await database();
    f.config.value.twitchClientId = "test-client";
    f.config.value.twitch = {
      access: "access",
      refresh: "refresh",
      expiresAt: Date.now() + 3600000,
      userId: "channel",
      scopes: [],
    };
    const p = await provider(
      (req) => {
        const u = new URL(req.url, "http://local");
        if (u.pathname.endsWith("/validate"))
          return {
            data: {
              client_id: "test-client",
              user_id: "channel",
              login: "Owner",
              scopes: ["user:read:chat", "moderator:read:chatters"],
            },
          };
        if (u.pathname.endsWith("/subscriptions"))
          return { status: 202, data: { data: [] } };
        if (u.pathname.endsWith("/streams"))
          return {
            data: {
              data: [
                {
                  id: "live-stream",
                  started_at: new Date(Date.now() - 60000).toISOString(),
                },
              ],
            },
          };
        if (u.pathname.endsWith("/chatters"))
          return {
            data: {
              data: [
                {
                  user_id: u.searchParams.has("after") ? "43" : "42",
                  user_name: "Viewer",
                  user_login: "viewer",
                },
              ],
              pagination: u.searchParams.has("after")
                ? {}
                : { cursor: "second" },
            },
          };
        assert.fail(req.url);
      },
      (s) => s.send(JSON.stringify(welcome())),
    );
    let factories = 0;
    const c = new TwitchConnection(f.config, f.db, p.request, (url, opts) => {
      factories++;
      return p.socket(url, opts);
    });
    try {
      await c.start();
      assert.equal(
        factories,
        1,
        "the adapter must use its transport dependency",
      );
      await until(() => c.status.state === "connected");
      // Presence poll is async after connect; wait rather than race the assertion.
      await until(() => c.status.capabilities.presence === "complete");
      assert.equal((await f.db.call("summary")).chatters, 2);
      const subs = p.requests
        .filter((r) => r.url.includes("/subscriptions"))
        .map((r) => JSON.parse(r.body));
      assert.equal(subs.length, 7);
      assert.equal(subs[0].transport.session_id, "session");
      assert.equal(c.status.capabilities["channel.cheer"], "Нет разрешения");
      p.sockets[0].send(JSON.stringify(chat()));
      p.sockets[0].send(JSON.stringify(chat()));
      await until(async () => (await f.db.call("summary")).messages === 1);
      p.sockets[0].send(
        JSON.stringify({
          metadata: { message_type: "revocation" },
          payload: {
            subscription: {
              type: "channel.chat.message",
              status: "authorization_revoked",
            },
          },
        }),
      );
      await until(
        () =>
          c.status.capabilities["channel.chat.message"] ===
          "authorization_revoked",
      );
      assert.equal((await f.db.call("sessions"))[0].stream_id, "twitch:live-stream");
    } finally {
      await c.stop();
      await p.close();
      await f.close();
    }
  },
);
test(
  "DA contract: legacy wire handshake + two-page REST + live overlap gives exact totals",
  { timeout: 20000 },
  async () => {
    const f = await database();
    f.config.value.daAccessToken = "access";
    const donation = {
      id: 123,
      amount: "0.29",
      currency: "RUB",
      username: "Viewer",
      message: "wire donation",
      created_at: "2026-10-06 12:00:00",
    };
    const p = await provider(
      (req, body) => {
        if (req.url.endsWith("/user/oauth"))
          return {
            data: {
              data: {
                id: 7,
                name: "Owner",
                socket_connection_token: "socket-token",
              },
            },
          };
        if (req.url.endsWith("/centrifuge/subscribe")) {
          const b = JSON.parse(body);
          assert.deepEqual(b.channels, ["$alerts:donation_7"]);
          assert.equal(b.client, "legacy-client");
          return {
            data: {
              channels: [
                { channel: "$alerts:donation_7", token: "channel-token" },
              ],
            },
          };
        }
        if (req.url.includes("/donations")) {
          const page = new URL(req.url, "http://local").searchParams.get(
            "page",
          );
          return {
            data: {
              data: page === "1" ? [donation] : [{ ...donation, id: 124 }],
              links: {
                next:
                  page === "1"
                    ? "https://www.donationalerts.com/api/v1/alerts/donations?page=2"
                    : null,
              },
            },
          };
        }
        assert.fail(req.url);
      },
      (s) =>
        s.on("message", (raw) => {
          const b = JSON.parse(raw.toString());
          if (b.id === 1) {
            assert.deepEqual(b, { params: { token: "socket-token" }, id: 1 });
            s.send(
              JSON.stringify({ id: 1, result: { client: "legacy-client" } }),
            );
          } else {
            assert.equal(b.method, 1);
            assert.equal(b.params.token, "channel-token");
            s.send(JSON.stringify({ id: 2, result: {} }));
            s.send(JSON.stringify({ result: { data: donation } }));
          }
        }),
    );
    let factories = 0;
    const c = new DonationAlertsConnection(
      f.config,
      f.db,
      p.request,
      (url, opts) => {
        factories++;
        return p.socket(url, opts);
      },
    );
    try {
      await c.start();
      assert.equal(factories, 1);
      await until(
        () =>
          c.status.capabilities.history === "Импорт доступных страниц завершён",
        10000,
      );
      assert.equal(c.status.capabilities.realtime, "подключено");
      const summary = await f.db.call("summary");
      assert.equal(summary.donations, 2);
      assert.equal(summary.totals.RUB, "58");
      assert.equal(
        (await f.db.call("events")).every((e) => e.occurred_at_ms === null),
        true,
      );
      await c.scanHistory();
      assert.equal((await f.db.call("summary")).donations, 2);
    } finally {
      await c.stop();
      await p.close();
      await f.close();
    }
  },
);
