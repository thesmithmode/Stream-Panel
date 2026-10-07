export type Source = "twitch" | "donationalerts";
export type TimeQuality = "provider" | "configured" | "unknown";

export interface EventInput {
  source: Source;
  accountId: string;
  externalId: string;
  type: string;
  actor: { externalId: string; displayName: string } | null;
  occurredAtMs: number | null;
  receivedAtMs: number;
  sourceTime: string | null;
  timeQuality: TimeQuality;
  transport: "eventsub" | "centrifugo" | "rest" | "streamerbot";
  payload: Record<string, unknown>;
}

export function assertTimestamp(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8_640_000_000_000_000
  ) {
    throw new Error("INVALID_TIMESTAMP");
  }
}

// This is a candidate-search key, never proof of identity.
// No transliteration, confusable-character folding, or stripping punctuation.
export function candidateKey(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase();
}

export function eventKey(
  event: Pick<EventInput, "source" | "accountId" | "type" | "externalId">,
): string {
  return JSON.stringify([
    event.source,
    event.accountId,
    event.type,
    event.externalId,
  ]);
}

const supportedCurrencies = new Set([
  "EUR",
  "USD",
  "RUB",
  "BYN",
  "KZT",
  "UAH",
  "BRL",
  "TRY",
]);

// Input must be a decimal string extracted before JSON numbers lose precision.
// Never multiply JS floating-point money. Decimal values outside this contract fail closed.
export function moneyToMinor(decimal: string, currency: string): string {
  if (!supportedCurrencies.has(currency))
    throw new Error("UNSUPPORTED_CURRENCY");
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(decimal);
  if (!match) throw new Error("INVALID_AMOUNT");
  return (
    BigInt(match[1]!) * 100n +
    BigInt((match[2] ?? "").padEnd(2, "0"))
  ).toString();
}

// Login-style key for high-confidence Twitch↔DA auto-link (tech-spec §3.3 rule 2).
// Strips leading @/# after NFKC; does not fold confusables or strip other punctuation.
export function matchKey(name: string): string {
  return name
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/^[@#]+/, "");
}

/** Stable DonationAlerts Donor identity key: one Donor per (account, display name). */
export function daDonorExternalId(displayName: string): string {
  const key = matchKey(displayName);
  if (!key) throw new Error("INVALID_DA_DONOR_NAME");
  return `name:${key}`;
}
