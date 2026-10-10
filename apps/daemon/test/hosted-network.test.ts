import test from "node:test";
import assert from "node:assert/strict";
import { parseHostedNetworkConfig } from "../src/hosted-network.js";

test("hosted networking defaults preserve loopback development behavior", () => {
  assert.deepEqual(parseHostedNetworkConfig(undefined, undefined), {
    bindHost: "127.0.0.1",
    trustedProxies: ["127.0.0.1", "::1"],
  });
});

test("hosted networking accepts RFC1918 bridge addresses and a single exact trusted proxy", () => {
  assert.deepEqual(
    parseHostedNetworkConfig("172.21.0.1", "172.21.0.2"),
    { bindHost: "172.21.0.1", trustedProxies: ["172.21.0.2"] },
  );
  assert.deepEqual(
    parseHostedNetworkConfig("127.0.0.1", "127.0.0.1"),
    { bindHost: "127.0.0.1", trustedProxies: ["127.0.0.1"] },
  );
});

test("hosted bind and trusted proxy reject public, wildcard, malformed, or ranged values", () => {
  for (const value of ["0.0.0.0", "8.8.8.8", "172.21.0.1/24", "invalid"])
    assert.throws(
      () => parseHostedNetworkConfig(value, undefined),
      /INVALID_STREAM_PANEL_BIND_HOST/,
    );

  for (const value of [
    "0.0.0.0",
    "8.8.8.8",
    "172.21.0.2/32",
    "*",
    "172.21.0.2,172.21.0.3",
  ])
    assert.throws(
      () => parseHostedNetworkConfig(undefined, value),
      /INVALID_STREAM_PANEL_TRUSTED_PROXY/,
    );
});
