/** Optional remote Postgres / Supabase sync (lean free-tier). Secrets stay local. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres, { type Sql } from "postgres";
import Database from "better-sqlite3";

export type RemoteDbKind = "none" | "postgres" | "supabase";

export type RemoteDbDesc = {
  configured: boolean;
  kind: RemoteDbKind;
  /** Redacted host hint for logs; never includes credentials. */
  hostHint: string | null;
  via: "pooler" | "direct" | null;
};

export type ResolvedUrls = {
  pooler: string | null;
  direct: string | null;
};

function hostHintOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return "(invalid-url)";
  }
}

function kindOf(url: string): RemoteDbKind {
  return /supabase|pooler\.supabase/i.test(url) ? "supabase" : "postgres";
}

function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(invalid-url)";
  }
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    const t = (await readFile(path, "utf8")).trim();
    return t || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Resolve pooler/direct URLs from env and optional out-of-tree creds dir. */
export async function resolveDatabaseUrls(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedUrls> {
  let pooler =
    env.STREAM_PANEL_DATABASE_POOLER_URL?.trim() ||
    env.SUPABASE_POOLER_URL?.trim() ||
    null;
  let direct =
    env.STREAM_PANEL_DATABASE_URL?.trim() ||
    env.SUPABASE_DB_URL?.trim() ||
    env.DATABASE_URL?.trim() ||
    null;

  const credsDir =
    env.STREAM_PANEL_CREDS_DIR?.trim() ||
    env.STREAM_PANEL_SUPABASE_CREDS_DIR?.trim() ||
    "";
  if (credsDir) {
    if (!pooler) {
      pooler =
        (await readOptionalText(join(credsDir, "supabase-pooler-url.txt"))) ||
        (await readOptionalText(
          join(credsDir, "supabase-database-pooler-url.txt"),
        ));
    }
    if (!direct) {
      direct = await readOptionalText(
        join(credsDir, "supabase-database-url.txt"),
      );
    }
    // Build from pieces + password file when URL files absent.
    if (!pooler || !direct) {
      const password =
        env.SUPABASE_DB_PASSWORD?.trim() ||
        env.STREAM_PANEL_DB_PASSWORD?.trim() ||
        (await readOptionalText(join(credsDir, "supabase-db-password.txt"))) ||
        (await readOptionalText(
          env.STREAM_PANEL_DB_PASSWORD_FILE?.trim() ||
            "/home/box/agent-data/secrets/stream-panel-supabase-db.password",
        ).catch(() => null));
      const ref =
        env.SUPABASE_PROJECT_REF?.trim() ||
        (await readOptionalText(join(credsDir, "supabase-project-ref.txt")));
      const poolerHost =
        env.STREAM_PANEL_DATABASE_POOLER_HOST?.trim() ||
        (await readOptionalText(join(credsDir, "supabase-pooler-host.txt"))) ||
        (ref ? "aws-0-eu-west-1.pooler.supabase.com" : null);
      const poolerUser =
        (await readOptionalText(join(credsDir, "supabase-pooler-user.txt"))) ||
        (ref ? `postgres.${ref}` : null);
      if (!pooler && password && poolerHost && poolerUser) {
        pooler = `postgresql://${encodeURIComponent(poolerUser)}:${encodeURIComponent(password)}@${poolerHost}:5432/postgres`;
      }
      if (!direct && password && ref) {
        direct = `postgresql://postgres:${encodeURIComponent(password)}@db.${ref}.supabase.co:5432/postgres`;
      }
    }
  }

  return { pooler, direct };
}

/** Describe config without connecting (for startup logs). */
export function describeRemoteDb(
  env: NodeJS.ProcessEnv = process.env,
  urls?: ResolvedUrls,
): RemoteDbDesc {
  const pooler =
    urls?.pooler ||
    env.STREAM_PANEL_DATABASE_POOLER_URL?.trim() ||
    env.SUPABASE_POOLER_URL?.trim() ||
    "";
  const direct =
    urls?.direct ||
    env.STREAM_PANEL_DATABASE_URL?.trim() ||
    env.SUPABASE_DB_URL?.trim() ||
    env.DATABASE_URL?.trim() ||
    "";
  const supabaseHttp = env.SUPABASE_URL?.trim() || "";
  if (pooler) {
    return {
      configured: true,
      kind: kindOf(pooler),
      hostHint: hostHintOf(pooler),
      via: "pooler",
    };
  }
  if (direct) {
    return {
      configured: true,
      kind: kindOf(direct),
      hostHint: hostHintOf(direct),
      via: "direct",
    };
  }
  if (supabaseHttp) {
    return {
      configured: true,
      kind: "supabase",
      hostHint: hostHintOf(supabaseHttp),
      via: null,
    };
  }
  return { configured: false, kind: "none", hostHint: null, via: null };
}

export type RemoteConnection = {
  sql: Sql;
  desc: RemoteDbDesc;
  close: () => Promise<void>;
};

async function tryConnect(
  url: string,
  via: "pooler" | "direct",
): Promise<RemoteConnection> {
  const sql = postgres(url, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 8,
    prepare: false, // session pooler friendly
  });
  await sql`select 1 as ok`;
  return {
    sql,
    desc: {
      configured: true,
      kind: kindOf(url),
      hostHint: hostHintOf(url),
      via,
    },
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

/** Prefer Session pooler (IPv4); fall back to direct. */
export async function connectRemoteDb(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RemoteConnection | null> {
  const urls = await resolveDatabaseUrls(env);
  const errors: string[] = [];
  if (urls.pooler) {
    try {
      return await tryConnect(urls.pooler, "pooler");
    } catch (error) {
      errors.push(`pooler:${hostHintOf(urls.pooler)}:${(error as Error).message}`);
    }
  }
  if (urls.direct) {
    try {
      return await tryConnect(urls.direct, "direct");
    } catch (error) {
      errors.push(`direct:${hostHintOf(urls.direct)}:${(error as Error).message}`);
    }
  }
  if (errors.length) {
    console.warn(
      `Remote DB connect failed (${errors.join(" | ")}). Continuing local-only.`,
    );
  }
  return null;
}

/** Idempotent lean schema for Viewer/Donor/Person sync (no secrets). */
export async function ensureRemoteSchema(sql: Sql): Promise<void> {
  await sql`
    create table if not exists sp_persons (
      id text primary key,
      display_name text not null,
      revision integer not null default 0,
      synced_at timestamptz not null default now()
    )`;
  await sql`
    create table if not exists sp_identities (
      id text primary key,
      source text not null,
      account_id text not null,
      external_id text not null,
      display_name text not null,
      candidate_key text not null,
      match_key text not null default '',
      person_id text not null references sp_persons(id),
      synced_at timestamptz not null default now(),
      unique (source, account_id, external_id)
    )`;
  await sql`
    create table if not exists sp_events (
      id text primary key,
      source text not null,
      account_id text not null,
      external_id text not null,
      type text not null,
      identity_id text,
      occurred_at_ms bigint,
      received_at_ms bigint not null,
      time_quality text not null,
      transport text not null,
      payload_json jsonb not null,
      synced_at timestamptz not null default now(),
      unique (source, account_id, type, external_id)
    )`;
  await sql`
    create table if not exists sp_presence_polls (
      id text primary key,
      session_id text not null,
      account_id text not null,
      started_at_ms bigint not null,
      completed_at_ms bigint not null,
      status text not null,
      synced_at timestamptz not null default now()
    )`;
  await sql`
    create table if not exists sp_presence_members (
      poll_id text not null references sp_presence_polls(id),
      identity_id text not null,
      primary key (poll_id, identity_id)
    )`;
}

export type SyncStats = {
  persons: number;
  identities: number;
  events: number;
  presencePolls: number;
  presenceMembers: number;
};

/** Push a lean snapshot from local SQLite → remote (upsert). */
export async function syncLeanFromSqlite(
  sql: Sql,
  sqlitePath: string,
  limits: { events?: number; presencePolls?: number } = {},
): Promise<SyncStats> {
  const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  try {
    const persons = db
      .prepare("SELECT id, display_name, revision FROM persons")
      .all() as { id: string; display_name: string; revision: number }[];
    const identities = db
      .prepare(
        `SELECT id, source, account_id, external_id, display_name, candidate_key,
                coalesce(match_key,'') AS match_key, person_id FROM identities`,
      )
      .all() as {
      id: string;
      source: string;
      account_id: string;
      external_id: string;
      display_name: string;
      candidate_key: string;
      match_key: string;
      person_id: string;
    }[];
    const eventLimit = limits.events ?? 5000;
    const events = db
      .prepare(
        `SELECT id, source, account_id, external_id, type, identity_id,
                occurred_at_ms, received_at_ms, time_quality, transport, payload_json
         FROM events ORDER BY received_at_ms DESC LIMIT ?`,
      )
      .all(eventLimit) as {
      id: string;
      source: string;
      account_id: string;
      external_id: string;
      type: string;
      identity_id: string | null;
      occurred_at_ms: number | null;
      received_at_ms: number;
      time_quality: string;
      transport: string;
      payload_json: string;
    }[];
    const pollLimit = limits.presencePolls ?? 200;
    const polls = db
      .prepare(
        `SELECT id, session_id, account_id, started_at_ms, completed_at_ms, status
         FROM presence_polls ORDER BY completed_at_ms DESC LIMIT ?`,
      )
      .all(pollLimit) as {
      id: string;
      session_id: string;
      account_id: string;
      started_at_ms: number;
      completed_at_ms: number;
      status: string;
    }[];
    const pollIds = polls.map((p) => p.id);
    let members: { poll_id: string; identity_id: string }[] = [];
    if (pollIds.length) {
      members = db
        .prepare(
          `SELECT poll_id, identity_id FROM presence_members
           WHERE poll_id IN (${pollIds.map(() => "?").join(",")})`,
        )
        .all(...pollIds) as { poll_id: string; identity_id: string }[];
    }

    if (persons.length) {
      await sql`
        insert into sp_persons ${sql(persons, "id", "display_name", "revision")}
        on conflict (id) do update set
          display_name = excluded.display_name,
          revision = excluded.revision,
          synced_at = now()`;
    }
    if (identities.length) {
      await sql`
        insert into sp_identities ${sql(
          identities,
          "id",
          "source",
          "account_id",
          "external_id",
          "display_name",
          "candidate_key",
          "match_key",
          "person_id",
        )}
        on conflict (id) do update set
          display_name = excluded.display_name,
          candidate_key = excluded.candidate_key,
          match_key = excluded.match_key,
          person_id = excluded.person_id,
          synced_at = now()`;
    }
    if (events.length) {
      const rows = events.map((e) => ({
        ...e,
        payload_json: JSON.parse(e.payload_json),
      }));
      await sql`
        insert into sp_events ${sql(
          rows,
          "id",
          "source",
          "account_id",
          "external_id",
          "type",
          "identity_id",
          "occurred_at_ms",
          "received_at_ms",
          "time_quality",
          "transport",
          "payload_json",
        )}
        on conflict (id) do update set
          identity_id = excluded.identity_id,
          occurred_at_ms = excluded.occurred_at_ms,
          received_at_ms = excluded.received_at_ms,
          payload_json = excluded.payload_json,
          synced_at = now()`;
    }
    if (polls.length) {
      await sql`
        insert into sp_presence_polls ${sql(
          polls,
          "id",
          "session_id",
          "account_id",
          "started_at_ms",
          "completed_at_ms",
          "status",
        )}
        on conflict (id) do update set
          status = excluded.status,
          completed_at_ms = excluded.completed_at_ms,
          synced_at = now()`;
    }
    if (members.length) {
      await sql`
        insert into sp_presence_members ${sql(members, "poll_id", "identity_id")}
        on conflict do nothing`;
    }

    return {
      persons: persons.length,
      identities: identities.length,
      events: events.length,
      presencePolls: polls.length,
      presenceMembers: members.length,
    };
  } finally {
    db.close();
  }
}

/** Start periodic lean sync; returns stop fn. No-op if remote unavailable. */
export function startRemoteSync(options: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
}): () => void {
  const env = options.env ?? process.env;
  const intervalMs = options.intervalMs ?? 60_000;
  const sqlitePath = join(options.dataDir, "data.sqlite");
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    let conn: RemoteConnection | null = null;
    try {
      conn = await connectRemoteDb(env);
      if (!conn) return;
      await ensureRemoteSchema(conn.sql);
      const stats = await syncLeanFromSqlite(conn.sql, sqlitePath);
      console.log(
        `Remote sync ok via ${conn.desc.via} (${conn.desc.hostHint}): persons=${stats.persons} identities=${stats.identities} events=${stats.events} presence=${stats.presencePolls}/${stats.presenceMembers}`,
      );
    } catch (error) {
      console.warn(`Remote sync skipped: ${(error as Error).message}`);
    } finally {
      if (conn) await conn.close().catch(() => {});
      running = false;
    }
  };

  void tick();
  timer = setInterval(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}

export const __test = { hostHintOf, kindOf, redact };
