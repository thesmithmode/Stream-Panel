import { assertTimestamp } from "./domain.js";

export interface PresencePoll {
  startedAtMs: number;
  completedAtMs: number;
  status: "complete" | "partial" | "failed";
  userIds: readonly string[];
}

export interface PresenceMinute {
  minuteStartMs: number;
  state: "observed" | "not_observed" | "unknown";
}

// Complete polls are non-atomic observations over a time window, not viewer telemetry.
// Partial/failed polls cannot produce a negative observation.
export function presenceMinutes(
  polls: readonly PresencePoll[],
  userId: string,
  fromMs: number,
  toMs: number,
): PresenceMinute[] {
  assertTimestamp(fromMs);
  assertTimestamp(toMs);
  if (
    fromMs % 60_000 ||
    toMs % 60_000 ||
    toMs < fromMs ||
    toMs - fromMs > 31 * 86_400_000
  ) {
    throw new Error("INVALID_MINUTE_RANGE");
  }
  const byMinute = new Map<number, PresencePoll[]>();
  for (const poll of polls) {
    assertTimestamp(poll.startedAtMs);
    assertTimestamp(poll.completedAtMs);
    if (poll.completedAtMs < poll.startedAtMs)
      throw new Error("INVALID_POLL_WINDOW");
    const minute = Math.floor(poll.completedAtMs / 60_000) * 60_000;
    const existing = byMinute.get(minute) ?? [];
    existing.push(poll);
    byMinute.set(minute, existing);
  }
  const result: PresenceMinute[] = [];
  for (let minute = fromMs; minute < toMs; minute += 60_000) {
    const inMinute = byMinute.get(minute) ?? [];
    const complete = inMinute.filter((poll) => poll.status === "complete");
    result.push({
      minuteStartMs: minute,
      state: complete.some((poll) => poll.userIds.includes(userId))
        ? "observed"
        : complete.length
          ? "not_observed"
          : "unknown",
    });
  }
  return result;
}
