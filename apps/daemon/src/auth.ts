import Database from "better-sqlite3";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const profiles = ["ruslan", "gulnaz"] as const;
export type Profile = typeof profiles[number];
export type UserSession = { profile: Profile; username: string; displayName: string; csrf: string; tokenHash: string };
type User = { profile: Profile; username: string; display_name: string; salt: string; password_hash: string };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const hashPassword = (password: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) => scrypt(password, salt, 32,
    { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
    (error, result) => error ? reject(error) : resolve(result)));

export class AccountStore {
  private db: Database.Database;
  private attempts = new Map<string, { count: number; until: number }>();
  private pending = 0;
  constructor(path: string, private now: () => number = Date.now) {
    this.db = new Database(path);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sp_users (
        profile TEXT PRIMARY KEY CHECK(profile IN ('ruslan','gulnaz')),
        username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        salt TEXT NOT NULL, password_hash TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sp_auth_sessions (
        token_hash TEXT PRIMARY KEY, profile TEXT NOT NULL REFERENCES sp_users(profile),
        csrf TEXT NOT NULL, expires_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sp_auth_expiry ON sp_auth_sessions(expires_at_ms);
    `);
  }
  users(): { profile: Profile; username: string; displayName: string }[] {
    return this.db.prepare("SELECT profile, username, display_name AS displayName FROM sp_users ORDER BY profile").all() as ReturnType<AccountStore["users"]>;
  }
  async createUser(profile: string, username: string, displayName: string, password: string): Promise<void> {
    if (!profiles.includes(profile as Profile)) throw new Error("INVALID_PROFILE");
    if (!/^[a-z][a-z0-9_.-]{2,31}$/.test(username) || !displayName.trim() || displayName.length > 100) throw new Error("INVALID_USER");
    if (password.length < 14 || password.length > 256) throw new Error("INVALID_PASSWORD");
    const salt = randomBytes(32).toString("hex");
    const hash = (await hashPassword(password, salt)).toString("hex");
    this.db.prepare("INSERT INTO sp_users VALUES (?, ?, ?, ?, ?)").run(profile, username, displayName, salt, hash);
  }
  async resetPassword(profile: string, password: string): Promise<void> {
    if (!profiles.includes(profile as Profile)) throw new Error("INVALID_PROFILE");
    if (password.length < 14 || password.length > 256) throw new Error("INVALID_PASSWORD");
    if (!this.db.prepare("SELECT 1 FROM sp_users WHERE profile=?").get(profile)) throw new Error("USER_NOT_FOUND");
    const salt = randomBytes(32).toString("hex"), hash = (await hashPassword(password, salt)).toString("hex");
    this.db.transaction(() => {
      this.db.prepare("UPDATE sp_users SET salt=?,password_hash=? WHERE profile=?").run(salt, hash, profile);
      this.db.prepare("DELETE FROM sp_auth_sessions WHERE profile=?").run(profile);
    }).immediate();
    this.attempts.clear();
  }
  async login(username: string, password: string, ip: string) {
    const key = `${ip}:${username.toLowerCase()}`;
    const ipKey = `ip:${ip}`;
    const now = this.now();
    for (const [k, value] of this.attempts) if (value.until <= now) this.attempts.delete(k);
    if (this.attempts.size >= 10000 || (this.attempts.get(key)?.count ?? 0) >= 5 || (this.attempts.get(ipKey)?.count ?? 0) >= 20) throw new Error("LOGIN_RATE_LIMIT");
    if (this.pending >= 4) throw new Error("AUTH_BUSY");
    const entry = this.attempts.get(key) ?? { count: 0, until: now + 900000 };
    entry.count++;
    this.attempts.set(key, entry);
    const ipEntry = this.attempts.get(ipKey) ?? { count: 0, until: now + 900000 };
    ipEntry.count++; this.attempts.set(ipKey, ipEntry);
    this.pending++;
    try {
      const user = this.db.prepare("SELECT * FROM sp_users WHERE username=?").get(username.toLowerCase()) as User | undefined;
      const actual = await hashPassword(password, user?.salt ?? "dummy-salt-for-unknown-user");
      const expected = user ? Buffer.from(user.password_hash, "hex") : Buffer.alloc(32);
      if (!timingSafeEqual(actual, expected) || !user) return null;
      this.attempts.delete(key);
      const token = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex");
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM sp_auth_sessions WHERE expires_at_ms<=?").run(now);
        const active = (this.db.prepare("SELECT count(*) AS n FROM sp_auth_sessions WHERE profile=?").get(user.profile) as { n: number }).n;
        if (active >= 20) throw new Error("TOO_MANY_SESSIONS");
        this.db.prepare("INSERT INTO sp_auth_sessions VALUES (?, ?, ?, ?)").run(digest(token), user.profile, csrf, now + 86400000);
      }).immediate();
      return { token, csrf, user: { profile: user.profile, username: user.username, displayName: user.display_name } };
    } finally { this.pending--; }
  }
  session(cookie?: string): UserSession | null {
    const token = /(?:^|;\s*)sp_session=([a-f0-9]{64})(?:;|$)/.exec(cookie ?? "")?.[1];
    if (!token) return null;
    const row = this.db.prepare(`SELECT u.profile, u.username, u.display_name AS displayName, s.csrf, s.token_hash AS tokenHash
      FROM sp_auth_sessions s JOIN sp_users u ON u.profile=s.profile
      WHERE s.token_hash=? AND s.expires_at_ms>?`).get(digest(token), this.now()) as UserSession | undefined;
    return row ?? null;
  }
  validCsrf(session: UserSession, token: unknown): boolean {
    if (typeof token !== "string") return false;
    const left = Buffer.from(token), right = Buffer.from(session.csrf);
    return left.length === right.length && timingSafeEqual(left, right);
  }
  logout(token: string): void { this.db.prepare("DELETE FROM sp_auth_sessions WHERE token_hash=?").run(digest(token)); }
  revoke(session: UserSession): void { this.db.prepare("DELETE FROM sp_auth_sessions WHERE token_hash=?").run(session.tokenHash); }
  close(): void { this.db.close(); }
}
