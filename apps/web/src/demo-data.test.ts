import test from "node:test";
import assert from "node:assert/strict";
import { getDataMode, setDataMode, demoApi } from "./demo-data.ts";

test("data mode toggles between real and demo", () => {
  setDataMode("real");
  assert.equal(getDataMode(), "real");
  setDataMode("demo");
  assert.equal(getDataMode(), "demo");
  setDataMode("real");
});

test("demoApi serves persons, events, status without touching secrets", async () => {
  setDataMode("demo");
  const persons = (await demoApi("persons")) as unknown[];
  assert.ok(Array.isArray(persons));
  assert.ok(persons.length >= 1);
  const events = (await demoApi("events")) as unknown[];
  assert.ok(Array.isArray(events));
  assert.ok(events.length >= 1);
  const status = (await demoApi("status")) as {
    twitch: { state: string };
    donationalerts: { state: string };
  };
  assert.equal(status.twitch.state, "connected");
  assert.equal(status.donationalerts.state, "connected");
  const insights = (await demoApi("insights")) as unknown[];
  assert.ok(Array.isArray(insights));
  const tops = (await demoApi("persons/tops?by=messages")) as unknown[];
  assert.ok(Array.isArray(tops));
  const summary = await demoApi("summary");
  assert.ok(summary);
  setDataMode("real");
});
