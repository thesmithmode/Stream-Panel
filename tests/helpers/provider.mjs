import { Configuration } from "../../dist/apps/daemon/src/config.js";
import { StoreClient } from "../../dist/apps/daemon/src/db.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
export async function until(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(10);
  }
  assert.fail("Expected state was not reached before timeout");
}
export async function provider(handler, onSocket) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body,
    });
    const reply = await handler(req, body);
    res.writeHead(
      reply.status ?? 200,
      reply.headers ?? { "content-type": "application/json" },
    );
    res.end(
      typeof reply.data === "string" ? reply.data : JSON.stringify(reply.data),
    );
  });
  const wss = new WebSocketServer({ server });
  const sockets = [];
  wss.on("connection", (s) => {
    sockets.push(s);
    onSocket?.(s, sockets.length);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    requests,
    sockets,
    request: (url, init) => {
      const u = new URL(url);
      return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
    },
    socket: (url, options) => new WebSocket(`ws://127.0.0.1:${port}`, options),
    close: async () => {
      for (const s of sockets) s.terminate();
      await new Promise((r) => wss.close(r));
      await new Promise((r) => server.close(r));
    },
  };
}
export async function database() {
  const dir = await mkdtemp(join(tmpdir(), "sp-provider-"));
  const config = new Configuration(dir);
  await config.load();
  const db = new StoreClient(join(dir, "data.sqlite"));
  await db.ready;
  return {
    config,
    db,
    close: async () => {
      await db.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
