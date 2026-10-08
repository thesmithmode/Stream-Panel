import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountStore } from "../src/auth.js";

test("password sessions persist, expire and revoke without exposing hashes or accepting forged cookies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-auth-"));
  const path = join(dir, "data.sqlite");
  let now = 1000;
  const auth = new AccountStore(path, () => now);
  try {
    await auth.createUser("ruslan", "ruslan", "Руслан", "correct-long-password");
    await auth.createUser("gulnaz", "gulnaz", "Гульназ", "another-long-password");
    assert.equal(await auth.login("ruslan", "bad", "ip"), null);
    assert.equal(await auth.login("missing", "bad", "ip"), null);
    const login = await auth.login("ruslan", "correct-long-password", "ip");
    assert.ok(login);
    assert.equal(login.user.profile, "ruslan");
    assert.equal(JSON.stringify(login.user).includes("hash"), false);
    assert.equal(auth.session(`sp_session=${login.token}`)?.profile, "ruslan");
    assert.equal(auth.session("sp_session=forged"), null);
    assert.equal(auth.validCsrf(auth.session(`sp_session=${login.token}`)!, login.csrf), true);
    assert.equal(auth.validCsrf(auth.session(`sp_session=${login.token}`)!, "wrong"), false);
    const second = await auth.login("gulnaz", "another-long-password", "ip2");
    assert.ok(second);
    auth.logout(login.token);
    assert.equal(auth.session(`sp_session=${login.token}`), null);
    assert.equal(auth.session(`sp_session=${second.token}`)?.profile, "gulnaz");
    now += 86400001;
    assert.equal(auth.session(`sp_session=${second.token}`), null);
    assert.equal(auth.session(undefined), null);
    await assert.rejects(auth.createUser("unknown", "abc", "X", "correct-long-password"), /INVALID_PROFILE/);
    await assert.rejects(auth.createUser("ruslan", "abc", "X", "short"), /INVALID_PASSWORD/);
    for (let i = 0; i < 5; i++) await auth.login("ruslan", "bad", "blocked");
    await assert.rejects(auth.login("ruslan", "correct-long-password", "blocked"), /LOGIN_RATE_LIMIT/);
    now += 900001;
    assert.ok(await auth.login("ruslan", "correct-long-password", "blocked"));
  } finally { auth.close(); await rm(dir, { recursive: true, force: true }); }
});
