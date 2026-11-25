export const FOLLOW_COOLDOWN_MS = 5 * 60_000;

/** Keep the first transition in each cooldown, independently for each account and direction. */
export function limitFollowRepeats<T extends { at: number }>(rows: T[], keyFor: (row: T) => string): T[] {
  const accepted = new Map<string, number>();
  return rows
    .sort((a, b) => a.at - b.at)
    .filter((row) => {
      const key = keyFor(row);
      const last = accepted.get(key);
      if (last !== undefined && row.at - last < FOLLOW_COOLDOWN_MS) return false;
      accepted.set(key, row.at);
      return true;
    });
}
