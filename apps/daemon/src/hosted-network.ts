import { isIPv4 } from "node:net";

export interface HostedNetworkConfig {
  bindHost: string;
  trustedProxies: readonly string[];
}

export const DEFAULT_HOSTED_NETWORK_CONFIG: HostedNetworkConfig = {
  bindHost: "127.0.0.1",
  trustedProxies: ["127.0.0.1", "::1"],
};

function assertAllowedIPv4(value: string, code: string): void {
  if (!isIPv4(value)) throw new Error(code);
  const octets = value.split(".").map(Number);
  const first = octets[0]!;
  const second = octets[1]!;
  const loopback = first === 127;
  const privateAddress =
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
  if (!loopback && !privateAddress) throw new Error(code);
}

export function parseHostedNetworkConfig(
  bindHost: string | undefined,
  trustedProxy: string | undefined,
): HostedNetworkConfig {
  const resolvedBindHost = bindHost ?? DEFAULT_HOSTED_NETWORK_CONFIG.bindHost;
  assertAllowedIPv4(resolvedBindHost, "INVALID_STREAM_PANEL_BIND_HOST");

  const trustedProxies =
    trustedProxy === undefined
      ? [...DEFAULT_HOSTED_NETWORK_CONFIG.trustedProxies]
      : [trustedProxy];
  for (const address of trustedProxies) {
    if (address === "::1") continue;
    assertAllowedIPv4(address, "INVALID_STREAM_PANEL_TRUSTED_PROXY");
  }

  return { bindHost: resolvedBindHost, trustedProxies };
}
