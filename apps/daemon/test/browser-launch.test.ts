import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  openBrowser,
  shouldOpenBrowser,
} from "../src/browser-launch.js";

test("shouldOpenBrowser skips NO_BROWSER, HEADLESS, CI, and headless Linux", () => {
  assert.equal(
    shouldOpenBrowser({ STREAM_PANEL_NO_BROWSER: "1", DISPLAY: ":0" }, "linux"),
    false,
  );
  assert.equal(
    shouldOpenBrowser({ STREAM_PANEL_HEADLESS: "1", DISPLAY: ":0" }, "linux"),
    false,
  );
  assert.equal(shouldOpenBrowser({ CI: "1", DISPLAY: ":0" }, "linux"), false);
  assert.equal(
    shouldOpenBrowser({ CI: "true", DISPLAY: ":0" }, "linux"),
    false,
  );
  assert.equal(shouldOpenBrowser({}, "linux"), false);
  assert.equal(
    shouldOpenBrowser({ WAYLAND_DISPLAY: "wayland-0" }, "linux"),
    true,
  );
  assert.equal(shouldOpenBrowser({ DISPLAY: ":0" }, "linux"), true);
  assert.equal(shouldOpenBrowser({}, "darwin"), true);
  assert.equal(shouldOpenBrowser({}, "win32"), true);
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    unref: () => void;
  };
  child.unref = () => {};
  return child;
}

test("openBrowser spawns the platform opener and swallows spawn errors", () => {
  const calls: { cmd: string; args: readonly string[]; opts: object }[] = [];
  const spawnFn = (cmd: string, args: readonly string[], opts: object) => {
    calls.push({ cmd, args, opts });
    return fakeChild() as never;
  };

  openBrowser("http://127.0.0.1:1/#key=a", { platform: "win32", spawnFn });
  openBrowser("http://127.0.0.1:1/#key=a", { platform: "darwin", spawnFn });
  openBrowser("http://127.0.0.1:1/#key=a", { platform: "linux", spawnFn });

  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.cmd, "cmd");
  assert.deepEqual(calls[0]!.args, ["/c", "start", "", "http://127.0.0.1:1/#key=a"]);
  assert.equal(calls[1]!.cmd, "open");
  assert.equal(calls[2]!.cmd, "xdg-open");

  const exploding = () => {
    throw new Error("spawn boom");
  };
  assert.doesNotThrow(() =>
    openBrowser("http://127.0.0.1:1/", {
      platform: "linux",
      spawnFn: exploding as never,
    }),
  );

  const errChild = fakeChild();
  openBrowser("http://127.0.0.1:1/", {
    platform: "linux",
    spawnFn: () => errChild as never,
  });
  errChild.emit("error", new Error("ENOENT"));
});
