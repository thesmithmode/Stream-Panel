import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeRemoteDb,
  resolveDatabaseUrls,
  ensureRemoteSchema,
  syncLeanFromSqlite,
} from "../src/remote-db.js";
import Database from "better-sqlite3";

test("describeRemoteDb: unset env → not configured", () => {
  assert.deepEqual(describeRemoteDb({}), {
    configured: false,
    kind: "none",
    hostHint: null,
    via: null,
  });
});

test("describeRemoteDb: pooler preferred in description", () => {
  const d = describeRemoteDb(
    {},
    {
      pooler: "postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:5432/postgres",
      direct: "postgresql://u:p@db.example.supabase.co:5432/postgres",
    },
  );
  assert.equal(d.via, "pooler");
  assert.equal(d.kind, "supabase");
  assert.equal(d.hostHint, "aws-0-eu-west-1.pooler.supabase.com");
});

test("describeRemoteDb: STREAM_PANEL_DATABASE_URL postgres", () => {
  const d = describeRemoteDb({
    STREAM_PANEL_DATABASE_URL: "postgres://user:secret@db.example:5432/app",
  });
  assert.equal(d.configured, true);
  assert.equal(d.kind, "postgres");
  assert.equal(d.hostHint, "db.example");
  assert.equal(d.via, "direct");
});

test("resolveDatabaseUrls reads pooler file from creds dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-creds-"));
  try {
    await writeFile(
      join(dir, "supabase-pooler-url.txt"),
      "postgresql://postgres.ref:secret@aws-0-eu-west-1.pooler.supabase.com:5432/postgres\n",
      { mode: 0o600 },
    );
    const urls = await resolveDatabaseUrls({ STREAM_PANEL_CREDS_DIR: dir });
    assert.ok(urls.pooler);
    assert.match(urls.pooler!, /pooler\.supabase\.com/);
    assert.equal(urls.direct, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureRemoteSchema + syncLeanFromSqlite against in-memory-ish local sqlite", async () => {
  // Skip live network unless explicitly enabled.
  if (process.env.STREAM_PANEL_REMOTE_DB_TEST !== "1") {
    assert.ok(true);
    return;
  }
  const { connectRemoteDb } = await import("../src/remote-db.js");
  const conn = await connectRemoteDb(process.env);
  assert.ok(conn, "expected remote connection");
  const dir = await mkdtemp(join(tmpdir(), "sp-sync-"));
  try {
    await ensureRemoteSchema(conn!.sql);
    const dbPath = join(dir, "data.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE persons (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE identities (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, account_id TEXT NOT NULL, external_id TEXT NOT NULL,
        display_name TEXT NOT NULL, candidate_key TEXT NOT NULL, person_id TEXT NOT NULL, match_key TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, account_id TEXT NOT NULL, external_id TEXT NOT NULL,
        type TEXT NOT NULL, identity_id TEXT, occurred_at_ms INTEGER, received_at_ms INTEGER NOT NULL,
        time_quality TEXT NOT NULL, transport TEXT NOT NULL, payload_json TEXT NOT NULL
      );
      CREATE TABLE presence_polls (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, account_id TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL, completed_at_ms INTEGER NOT NULL, status TEXT NOT NULL
      );
      CREATE TABLE presence_members (poll_id TEXT NOT NULL, identity_id TEXT NOT NULL, PRIMARY KEY(poll_id, identity_id));
      INSERT INTO persons VALUES ('p1','Alice',1);
      INSERT INTO identities VALUES ('i1','twitch','acc','ext','Alice','alice','p1','alice');
      INSERT INTO events VALUES ('e1','twitch','acc','ext1','chat.message','i1',1,1,'provider','eventsub','{}');
    `);
    db.close();
    const stats = await syncLeanFromSqlite(conn!.sql, dbPath);
    assert.equal(stats.persons, 1);
    assert.equal(stats.identities, 1);
    assert.equal(stats.events, 1);
  } finally {
    await conn!.close();
    await rm(dir, { recursive: true, force: true });
  }
});
