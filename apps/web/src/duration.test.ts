import test from "node:test";
import assert from "node:assert/strict";
import { formatDuration } from "./duration.ts";

test("formats duration boundaries without zero-valued trailing units", () => {
  const cases: Array<[number, string]> = [
    [0, "0 мин"],
    [0.5, "<1 мин"],
    [59, "59 мин"],
    [60, "1 ч"],
    [61, "1 ч 1 мин"],
    [1_439, "23 ч 59 мин"],
    [1_440, "1 д"],
    [1_502, "1 д 1 ч 2 мин"],
  ];

  for (const [minutes, expected] of cases)
    assert.equal(formatDuration(minutes), expected, `${minutes} minutes`);
});

test("floors fractional minutes and handles omitted or invalid durations", () => {
  assert.equal(formatDuration(1.9), "1 мин");
  assert.equal(formatDuration(60.9), "1 ч");

  for (const minutes of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY, -1, -0.5])
    assert.equal(formatDuration(minutes), "—");
});

test("rejects values whose floored minute count is not a safe integer", () => {
  assert.equal(formatDuration(Number.MAX_SAFE_INTEGER), `${Math.floor(Number.MAX_SAFE_INTEGER / 1_440)} д 31 мин`);
  assert.equal(formatDuration(Number.MAX_SAFE_INTEGER + 1), "—");
});
