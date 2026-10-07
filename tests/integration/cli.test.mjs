import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
function start(dir, port, extra = {}) {
  const child = spawn(process.execPath, ["dist/apps/daemon/src/index.js"], { env: { ...process.env, STREAM_PANEL_DATA_DIR: dir, STREAM_PANEL_PORT: String(port), STREAM_PANEL_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (b) => stdout += b); child.stderr.on("data", (b) => stderr += b);
  const exit = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal, stdout, stderr })));
  const ready = async () => { const deadline = Date.now() + 15000; while (!stdout.includes("server listening")) { if (child.exitCode !== null) throw new Error(stderr); if (Date.now() > deadline) throw new Error("START_TIMEOUT"); await new Promise((r) => setTimeout(r, 10)); } };
  return { child, exit, ready };
}
test("server entrypoint serves health, rejects a second listener, shuts down and reopens one SQLite", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-server-cli-")); const port = await freePort(); const children = [];
  try {
    const a = start(dir, port); children.push(a); await a.ready();
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/events`)).status, 401);
    const duplicate = start(dir, port); children.push(duplicate); assert.equal((await duplicate.exit).code, 1);
    a.child.kill("SIGTERM"); assert.equal((await a.exit).code, 0);
    const b = start(dir, port); children.push(b); await b.ready(); b.child.kill("SIGINT"); assert.equal((await b.exit).code, 0);
  } finally { for (const c of children) c.child.kill(); await Promise.all(children.map((c) => c.exit)); await rm(dir, { recursive: true, force: true }); }
});
test("server entrypoint fails before exposing data when origin, directory or port is invalid", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-server-invalid-"));
  try {
    for (const [env, expected] of [[{ STREAM_PANEL_PUBLIC_ORIGIN: "" }, "PUBLIC_ORIGIN_REQUIRED"], [{ STREAM_PANEL_DATA_DIR: "" }, "DATA_DIR_REQUIRED"], [{ STREAM_PANEL_PORT: "80" }, "INVALID_PORT"], [{ STREAM_PANEL_PUBLIC_ORIGIN: "http://public.example.test" }, "INVALID_PUBLIC_ORIGIN"]]) {
      const c = start(dir, 47831, env); const r = await c.exit; assert.equal(r.code, 1); assert.match(r.stderr, new RegExp(expected));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
