import { assertTimestamp } from "./domain.js";
import type { PresencePoll } from "./presence.js";

export interface ChattersPage {
  data: { user_id: string; user_login: string; user_name: string }[];
  pagination: { cursor?: string };
}

// The adapter supplies HTTP, token rotation, abort, and rate-limit handling.
// A completed sweep is still not an atomic snapshot of Twitch's changing list.
export async function collectChatters(
  fetchPage: (cursor: string | undefined) => Promise<ChattersPage>,
  now: () => number = Date.now,
  maxPages = 100,
): Promise<PresencePoll> {
  if (!Number.isInteger(maxPages) || maxPages < 1)
    throw new Error("INVALID_PAGE_LIMIT");
  const startedAtMs = now();
  assertTimestamp(startedAtMs);
  const users = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let status: PresencePoll["status"] = "partial";
  try {
    for (let page = 0; page < maxPages; page++) {
      const response = await fetchPage(cursor);
      if (!Array.isArray(response.data) || !response.pagination)
        throw new Error("INVALID_PAGE");
      for (const user of response.data) {
        if (typeof user.user_id !== "string" || !user.user_id)
          throw new Error("INVALID_USER");
        users.add(user.user_id);
      }
      cursor = response.pagination.cursor;
      if (cursor === undefined || cursor === "") {
        status = "complete";
        break;
      }
      if (typeof cursor !== "string" || cursors.has(cursor))
        throw new Error("PAGINATION_CYCLE");
      cursors.add(cursor);
    }
  } catch {
    status = users.size ? "partial" : "failed";
  }
  const completedAtMs = now();
  assertTimestamp(completedAtMs);
  if (completedAtMs < startedAtMs) throw new Error("CLOCK_MOVED_BACKWARDS");
  return { startedAtMs, completedAtMs, status, userIds: [...users] };
}
