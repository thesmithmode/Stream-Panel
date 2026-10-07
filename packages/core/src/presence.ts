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

// Complete polls cover [startedAtMs, completedAtMs] minute buckets (inclusive).
// Callers set startedAtMs to the previous successful poll completion so the
// observation spans the whole interval, not only the completion minute.
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
  for (const poll of polls) {
    assertTimestamp(poll.startedAtMs);
    assertTimestamp(poll.completedAtMs);
    if (poll.completedAtMs < poll.startedAtMs)
      throw new Error("INVALID_POLL_WINDOW");
  }
  const result: PresenceMinute[] = [];
  for (let minute = fromMs; minute < toMs; minute += 60_000) {
    const complete = polls.filter((poll) => {
      if (poll.status !== "complete") return false;
      const first = Math.floor(poll.startedAtMs / 60_000) * 60_000;
      const last = Math.floor(poll.completedAtMs / 60_000) * 60_000;
      return minute >= first && minute <= last;
    });
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

export function clampChattersPollSeconds(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 60;
  return Math.min(120, Math.max(60, Math.round(n)));
}

/** Inclusive minute buckets covered by a complete poll window (same as presenceMinutes). */
export function pollCoveredMinutes(
  startedAtMs: number,
  completedAtMs: number,
  fromMs?: number,
  toMs?: number,
): number[] {
  assertTimestamp(startedAtMs);
  assertTimestamp(completedAtMs);
  if (completedAtMs < startedAtMs) throw new Error("INVALID_POLL_WINDOW");
  const first = Math.floor(startedAtMs / 60_000) * 60_000;
  const last = Math.floor(completedAtMs / 60_000) * 60_000;
  const out: number[] = [];
  for (let minute = first; minute <= last; minute += 60_000) {
    if (fromMs !== undefined && minute < fromMs) continue;
    if (toMs !== undefined && minute >= toMs) continue;
    out.push(minute);
  }
  return out;
}

