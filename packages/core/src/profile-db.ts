import Database from "better-sqlite3";
import { schemaV1, schemaV2, schemaV3, schemaV4, schemaV5, schemaV6, schemaV7, schemaV8, schemaV9, schemaV10, schemaV11 } from "./schema.js";

// Only trusted schema identifiers are rewritten. Bound data and SQL string
// literals are never rewritten. Each profile has its own tables, indexes,
// foreign keys and migration version inside the same physical SQLite file.
const identifiers = new Set(
  [...`${schemaV1}\n${schemaV2}\n${schemaV3}\n${schemaV4}\n${schemaV5}\n${schemaV6}\n${schemaV7}\n${schemaV8}\n${schemaV9}\n${schemaV10}\n${schemaV11}`.matchAll(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW)\s+(?:IF NOT EXISTS\s+)?(\w+)/gi)].map((m) => m[1]!),
);
export function openProfileDatabase(path: string, profile?: string): Database.Database {
  if (profile !== undefined && !/^[a-z][a-z0-9_]{0,31}$/.test(profile))
    throw new Error("INVALID_PROFILE");
  const db = new Database(path);
  if (profile === undefined) return db;
  db.pragma("busy_timeout = 5000");
  db.exec("CREATE TABLE IF NOT EXISTS sp_profile_schema (profile TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT");
  const prefix = `p_${profile}_`;
  const rewrite = (sql: string) => sql.replace(/'(?:''|[^'])*'|\b[a-z_][a-z0-9_]*\b/gi,
    (token) => identifiers.has(token.toLowerCase()) ? prefix + token : token);
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => target.prepare(rewrite(sql));
      if (property === "exec") return (sql: string) => {
        let version: number | undefined;
        const clean = sql.replace(/PRAGMA\s+user_version\s*=\s*(\d+)\s*;/gi,
          (_, n: string) => { version = Number(n); return ""; });
        target.exec(rewrite(clean));
        if (version !== undefined) target.prepare("INSERT INTO sp_profile_schema VALUES (?, ?) ON CONFLICT(profile) DO UPDATE SET version=excluded.version").run(profile, version);
        return target;
      };
      if (property === "pragma") return (sql: string, options?: Database.PragmaOptions) => {
        if (sql.trim() === "user_version") {
          const row = target.prepare("SELECT version FROM sp_profile_schema WHERE profile=?").get(profile) as { version: number } | undefined;
          const version = row?.version ?? 0;
          return options?.simple ? version : [{ user_version: version }];
        }
        return target.pragma(sql, options);
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
