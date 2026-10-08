import test from "node:test";
import assert from "node:assert/strict";
import { createProfileSelection } from "./profile.ts";

test("two clients sharing browser storage retain independent request scopes", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const a = createProfileSelection(() => storage);
  const b = createProfileSelection(() => storage);
  assert.equal(a.get(), "ruslan");
  assert.equal(b.get(), "ruslan");
  a.set("gulnaz");
  assert.equal(a.get(), "gulnaz");
  assert.equal(b.get(), "ruslan");
  assert.equal(values.get("sp-profile"), "gulnaz");
  const reopened = createProfileSelection(() => storage);
  assert.equal(reopened.get(), "gulnaz");
  b.set("ruslan");
  assert.equal(a.get(), "gulnaz");
  assert.equal(reopened.get(), "gulnaz");
  assert.equal(b.get(), "ruslan");
});

test("unavailable storage preserves valid choices and rejects forged profiles before persistence", () => {
  const denied = createProfileSelection(() => { throw new Error("Storage denied"); });
  assert.equal(denied.get(), "ruslan");
  denied.set("gulnaz");
  assert.equal(denied.get(), "gulnaz");
  denied.set("ruslan");
  assert.equal(denied.get(), "ruslan");
  for (const value of ["other", "", "RUSLAN", null, undefined, ["gulnaz"]]) {
    assert.throws(() => denied.set(value as "ruslan"), /INVALID_PROFILE/);
    assert.equal(denied.get(), "ruslan");
  }
  const corrupted = createProfileSelection(() => ({ getItem: () => "unknown", setItem() {} }));
  assert.equal(corrupted.get(), "ruslan");
  corrupted.set("gulnaz");
  assert.equal(corrupted.get(), "gulnaz");
});
