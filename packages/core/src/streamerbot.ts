import type { EventInput } from "./domain.js";

/**
 * Minimal surface for a future @streamerbot/client adapter (P3).
 * UDP DoAction is inbound-to-SB only — not used as analytics ingest.
 */
export interface StreamerBotClientLike {
  on(
    event: "Twitch.ChatMessage",
    handler: (data: StreamerBotTwitchChatMessage) => void,
  ): void;
  connect?: () => Promise<void> | void;
  disconnect?: () => Promise<void> | void;
}

/** Shape aligned with Streamer.bot Twitch.ChatMessage payloads (fields we map). */
export interface StreamerBotTwitchChatMessage {
  messageId?: string;
  message?: string | { text?: string };
  user?: {
    id?: string | number;
    name?: string;
    displayName?: string;
    login?: string;
  };
  userId?: string | number;
  username?: string;
  userName?: string;
  displayName?: string;
  timeStamp?: string | number;
}

export interface StreamerBotAdapter {
  readonly source: "streamerbot";
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Register a sink for normalized events. */
  subscribe(handler: (event: EventInput) => void | Promise<void>): void;
}

function textOf(message: StreamerBotTwitchChatMessage["message"]): string {
  if (typeof message === "string") return message;
  if (message && typeof message === "object") return String(message.text ?? "");
  return "";
}

/**
 * Map Streamer.bot Twitch.ChatMessage → EventInput (transport streamerbot).
 * Returns null when required ids are missing (fail closed).
 */
export function mapStreamerBotTwitchChatMessage(
  data: StreamerBotTwitchChatMessage,
  accountId: string,
  receivedAtMs: number,
): EventInput | null {
  const userId = String(data.user?.id ?? data.userId ?? "");
  const display =
    data.user?.displayName ||
    data.displayName ||
    data.user?.name ||
    data.userName ||
    data.username ||
    data.user?.login ||
    "";
  const externalId = String(data.messageId ?? "");
  if (!accountId || !externalId || !userId) return null;
  let occurredAtMs: number | null = null;
  let sourceTime: string | null = null;
  let timeQuality: EventInput["timeQuality"] = "unknown";
  if (data.timeStamp !== undefined && data.timeStamp !== null) {
    const raw = data.timeStamp;
    const at =
      typeof raw === "number"
        ? raw
        : Number.isFinite(Date.parse(String(raw)))
          ? Date.parse(String(raw))
          : Number.NaN;
    if (Number.isFinite(at)) {
      occurredAtMs = at;
      sourceTime = typeof raw === "string" ? raw : new Date(at).toISOString();
      timeQuality = "provider";
    }
  }
  return {
    source: "twitch",
    accountId,
    externalId,
    type: "chat.message",
    actor: { externalId: userId, displayName: display || userId },
    occurredAtMs,
    receivedAtMs,
    sourceTime,
    timeQuality,
    transport: "streamerbot",
    payload: {
      text: textOf(data.message),
      actorName: display || userId,
      originChannelId: accountId,
      streamerbot: 1,
    },
  };
}

/**
 * Offline stub: keeps the adapter interface without requiring @streamerbot/client.
 * Full WS client wiring is deferred to P3 (live Streamer.bot + dedupe with direct Twitch).
 */
export class StreamerBotStubAdapter implements StreamerBotAdapter {
  readonly source = "streamerbot" as const;
  private handlers: Array<(event: EventInput) => void | Promise<void>> = [];
  private running = false;

  constructor(
    private readonly accountId: string,
    private readonly client: StreamerBotClientLike | null = null,
  ) {}

  subscribe(handler: (event: EventInput) => void | Promise<void>): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (!this.client) return;
    this.client.on("Twitch.ChatMessage", (data) => {
      const event = mapStreamerBotTwitchChatMessage(
        data,
        this.accountId,
        Date.now(),
      );
      if (!event) return;
      for (const handler of this.handlers) void handler(event);
    });
    await this.client.connect?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.client?.disconnect?.();
  }

  /** Test helper: inject a mapped message without a live client. */
  async inject(data: StreamerBotTwitchChatMessage, atMs = Date.now()): Promise<void> {
    const event = mapStreamerBotTwitchChatMessage(data, this.accountId, atMs);
    if (!event) return;
    for (const handler of this.handlers) await handler(event);
  }
}
