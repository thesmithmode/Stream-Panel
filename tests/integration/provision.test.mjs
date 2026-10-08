import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../../dist/apps/daemon/src/auth.js";

const script = "scripts/provision-accounts.mjs";
const first = { profile: "ruslan", username: "ruslan", displayName: "Ruslan", password: "correct-horse-battery-1" };
const second = { profile: "gulnaz", username: "gulnaz", displayName: "Gulnaz", password: "correct-horse-battery-2" };

function provision(dir, users, args = []) {
  const child = spawn(process.execPath, [script, ...args], {
    env: { ...process.env, STREAM_PANEL_DATA_DIR: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => stdout += chunk);
  child.stderr.on("data", (chunk) => stderr += chunk);
  const exit = new Promise((resolve) => child.once("close", (code) => resolve({ code, stdout, stderr })));
  child.stdin.end(JSON.stringify(users));
  return exit;
}

function snapshot(path) {
  const db = new Database(path, { readonly: true });
  try {
    return {
      users: db.prepare("SELECT profile, username, display_name, salt, password_hash FROM sp_users ORDER BY profile").all(),
      sessions: db.prepare("SELECT token_hash, profile, csrf, expires_at_ms FROM sp_auth_sessions ORDER BY token_hash").all(),
    };
  } finally { db.close(); }
}

test("--resume verifies existing accounts, preserves sessions and adds only missing accounts", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-provision-resume-"));
  const dbPath = join(dir, "data.sqlite");
  try {
    assert.equal((await provision(dir, [first])).code, 0);
    const auth = new AccountStore(dbPath);
    try { assert.ok(await auth.login(first.username, first.password, "127.0.0.1")); }
    finally { auth.close(); }
    const before = snapshot(dbPath);
    assert.equal((await provision(dir, [first, second], ["--resume"])).code, 0);
    const afterCreate = snapshot(dbPath);
    assert.deepEqual(afterCreate.users.find((user) => user.profile === first.profile), before.users[0]);
    assert.deepEqual(afterCreate.sessions, before.sessions);
    assert.deepEqual(afterCreate.users.map((user) => user.profile), ["gulnaz", "ruslan"]);

    assert.equal((await provision(dir, [first, second], ["--resume"])).code, 0);
    assert.deepEqual(snapshot(dbPath), afterCreate);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("--resume rejects changed credentials or profile without changing stored users or sessions", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-provision-mismatch-"));
  const dbPath = join(dir, "data.sqlite");
  try {
    assert.equal((await provision(dir, [first])).code, 0);
    const auth = new AccountStore(dbPath);
    try { assert.ok(await auth.login(first.username, first.password, "127.0.0.1")); }
    finally { auth.close(); }
    const original = snapshot(dbPath);
    const changed = [
      { ...first, password: "different-horse-battery-3" },
      { ...first, username: "othername" },
      { ...first, displayName: "Different name" },
      { ...first, profile: "gulnaz" },
    ];
    for (const user of changed) {
      const result = await provision(dir, [user], ["--resume"]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /RESUME_ACCOUNT_MISMATCH/);
      assert.deepEqual(snapshot(dbPath), original);
    }
    const stillWorks = new AccountStore(dbPath);
    try { assert.ok(await stillWorks.login(first.username, first.password, "127.0.0.1")); }
    finally { stillWorks.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("all input users are validated before creating the data directory or database", async () => {
  const parent = await mkdtemp(join(tmpdir(), "sp-provision-invalid-"));
  const dir = join(parent, "not-created");
  try {
    const result = await provision(dir, [first, { ...second, password: "short" }]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /INVALID_PASSWORD/);
    await assert.rejects(import("node:fs/promises").then(({ stat }) => stat(dir)), { code: "ENOENT" });
  } finally { await rm(parent, { recursive: true, force: true }); }
});
