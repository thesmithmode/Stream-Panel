// Administrator-only provisioning. Passwords arrive on stdin, never argv/logs.
import Database from "better-sqlite3";
import { promisify } from "node:util";
import { scrypt, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AccountStore, profiles } from "../dist/apps/daemon/src/auth.js";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--resume") || args.filter((arg) => arg === "--resume").length > 1) throw new Error("INVALID_ARGS");
const resume = args.includes("--resume");
const dir = process.env.STREAM_PANEL_DATA_DIR;
if (!dir) throw new Error("DATA_DIR_REQUIRED");

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 8192) throw new Error("INPUT_TOO_LARGE");
}
const users = JSON.parse(input);
if (!Array.isArray(users) || users.length > 2) throw new Error("INVALID_USERS");

const profileSet = new Set();
const usernameSet = new Set();
for (const user of users) {
  if (!user || typeof user !== "object" || Array.isArray(user)) throw new Error("INVALID_USERS");
  const { profile, username, displayName, password } = user;
  if (!profiles.includes(profile) || profileSet.has(profile)) throw new Error("INVALID_PROFILE");
  if (typeof username !== "string" || !/^[a-z][a-z0-9_.-]{2,31}$/.test(username) ||
      typeof displayName !== "string" || !displayName.trim() || displayName.length > 100 ||
      usernameSet.has(username)) throw new Error("INVALID_USER");
  if (typeof password !== "string" || password.length < 14 || password.length > 256) throw new Error("INVALID_PASSWORD");
  profileSet.add(profile);
  usernameSet.add(username);
}

const dbPath = join(dir, "data.sqlite");
const scryptAsync = promisify(scrypt);
if (resume && existsSync(dbPath)) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let existing = [];
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sp_users'").get();
    if (table) existing = db.prepare("SELECT profile, username, display_name, salt, password_hash FROM sp_users").all();
  } finally {
    db.close();
  }

  const byProfile = new Map(existing.map((user) => [user.profile, user]));
  const byUsername = new Map(existing.map((user) => [user.username, user]));
  for (const requested of users) {
    const current = byProfile.get(requested.profile);
    if (!current) {
      if (byUsername.has(requested.username)) throw new Error("RESUME_ACCOUNT_MISMATCH");
      continue;
    }
    const actual = Buffer.from(await scryptAsync(requested.password, current.salt, 32, {
      N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
    }));
    const expected = /^[a-f0-9]{64}$/.test(current.password_hash)
      ? Buffer.from(current.password_hash, "hex")
      : Buffer.alloc(0);
    if (current.username !== requested.username || current.display_name !== requested.displayName ||
        expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
      throw new Error("RESUME_ACCOUNT_MISMATCH");
    }
  }
}

await mkdir(dir, { recursive: true, mode: 0o700 });
const auth = new AccountStore(dbPath);
try {
  if (resume) {
    const existingProfiles = new Set(auth.users().map((user) => user.profile));
    for (const user of users) {
      if (!existingProfiles.has(user.profile)) await auth.createUser(user.profile, user.username, user.displayName, user.password);
    }
  } else {
    for (const user of users) await auth.createUser(user.profile, user.username, user.displayName, user.password);
  }
  console.log(resume ? "Accounts verified; missing accounts created." : "Accounts created; passwords were not logged.");
} finally {
  auth.close();
}
