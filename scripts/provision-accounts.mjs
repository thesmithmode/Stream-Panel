// Administrator-only provisioning. Passwords arrive on stdin, never argv/logs.
import { AccountStore } from "../dist/apps/daemon/src/auth.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
const dir = process.env.STREAM_PANEL_DATA_DIR;
if (!dir) throw new Error("DATA_DIR_REQUIRED");
await mkdir(dir, { recursive: true, mode: 0o700 });
let input = ""; for await (const chunk of process.stdin) { input += chunk; if (input.length > 8192) throw new Error("INPUT_TOO_LARGE"); }
const users = JSON.parse(input); if (!Array.isArray(users) || users.length > 2) throw new Error("INVALID_USERS");
const auth = new AccountStore(join(dir, "data.sqlite"));
try { for (const u of users) await auth.createUser(u.profile, u.username, u.displayName, u.password); console.log("Accounts created; passwords were not logged."); }
finally { auth.close(); }
