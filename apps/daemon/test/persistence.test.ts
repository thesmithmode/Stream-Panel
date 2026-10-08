import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Configuration, defaultDataDir } from "../src/config.js";
import { StoreClient } from "../src/db.js";
test("configuration rejects invalid versions/JSON and recovers its serialized write queue after a disk failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-config-errors-"));
  try {
    const path = join(dir, "secrets.json");
    await writeFile(path, "{");
    await assert.rejects(new Configuration(dir).load(), SyntaxError);
    await writeFile(path, JSON.stringify({ version: 2 }));
    await assert.rejects(new Configuration(dir).load(), /UNSUPPORTED_CONFIG/);
    await rm(path);
    await mkdir(path);
    const c = new Configuration(dir);
    c.value.daClientId = "own-app";
    await assert.rejects(c.save());
    await rm(path, { recursive: true });
    await c.save();
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).daClientId,
      "own-app",
    );
    const loaded = new Configuration(dir);
    await loaded.load();
    assert.equal(loaded.value.daClientId, "own-app");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("default data directory obeys explicit override and platform defaults", () => {
  const vars = [
    "STREAM_PANEL_DATA_DIR",
    "XDG_DATA_HOME",
  ] as const;
  const saved = Object.fromEntries(vars.map((v) => [v, process.env[v]]));
  try {
    process.env.STREAM_PANEL_DATA_DIR = "/explicit";
    assert.equal(defaultDataDir(), "/explicit");
    delete process.env.STREAM_PANEL_DATA_DIR;
    process.env.XDG_DATA_HOME = "/xdg";
    assert.equal(defaultDataDir(), join("/xdg", "stream-panel"));
    delete process.env.XDG_DATA_HOME;
    assert.ok(
      defaultDataDir().endsWith(join(".local", "share", "stream-panel")),
    );
  } finally {
    for (const v of vars) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  }
});
test("worker RPC rejects unsupported operations and oversubscription but remains usable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-queue-"));
  const db = new StoreClient(join(dir, "db.sqlite"));
  try {
    await db.ready;
    await assert.rejects(db.call("not-an-operation"), /UNKNOWN_OPERATION/);
    const results = await Promise.allSettled(
      Array.from({ length: 10002 }, () => db.call("persons")),
    );
    assert.equal(results.filter((x) => x.status === "rejected").length, 2);
    for (const x of results)
      if (x.status === "rejected")
        assert.match(x.reason.message, /QUEUE_OVERFLOW/);
    assert.deepEqual(await db.call("persons"), []);
  } finally {
    await db.stop();
    await db.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
test("future schema fails worker startup and rejects callers instead of waiting forever", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-worker-start-"));
  const path = join(dir, "db.sqlite");
  const sql = new Database(path);
  sql.pragma("user_version=999");
  sql.close();
  const db = new StoreClient(path);
  try {
    await assert.rejects(db.ready, /UNSUPPORTED_SCHEMA_VERSION/);
    await assert.rejects(db.call("persons"), /UNSUPPORTED_SCHEMA_VERSION/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("uncloneable worker arguments never consume queue capacity", async () => {
  const db = new StoreClient(":memory:");
  try {
    await db.ready;
    for (let i = 0; i < 10000; i++)
      await assert.rejects(
        db.call("persons", () => {}),
        /could not be cloned/,
      );
    assert.deepEqual(await db.call("persons"), []);
  } finally {
    await db.stop();
  }
});

test('legacy configuration preserves saved YouTube history and restores required exclusions from a malformed optional bot list',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-legacy-config-'));
 try {
  const path=join(dir,'secrets.json');
  await writeFile(path,JSON.stringify({version:1,youtubeAccountId:'history-owner',excludedBotLogins:'wrong-type'}));
  const config=new Configuration(dir);await config.load();
  assert.equal(config.value.youtubeAccountId,'history-owner');
  assert.deepEqual(config.value.excludedBotLogins,['fullrandomname_twitch','jeetbot','streemelements','streamelements']);
  await writeFile(path,JSON.stringify({version:1,youtube:{userId:'connected-owner'}}));await config.load();
  assert.equal(config.value.youtubeAccountId,'connected-owner');
 } finally {await rm(dir,{recursive:true,force:true});}
});
