import { parentPort, workerData } from "node:worker_threads";
import { StreamStore } from "../../../packages/core/src/store.js";
const store = new StreamStore(String(workerData.path), workerData.profile);
const allowed = new Set([
  "analytics", "streamSample", "youtubeViewers",
  "youtubeQuota", "youtubeSnapshot", "youtubeMessages", "youtubeData",
  "ingest",
  "ingestLiveDonation",
  "sessions",
  "platformStreams",
  "platformMissing",
  "attachPlatformStream",
  "observePlatformStream",
  "activeLogicalStream",
  "startSession",
  "endSession",
  "deleteManualSession",
  "recordPoll",
  "updateChatterNames",
  "persons", "createPerson",
  "person",
  "personNotes", "createPersonNote", "updatePersonNote", "deletePersonNote",
  "personMetadata", "setPersonMetadata",
  "donation", "donations", "createDonation", "updateDonation", "deleteDonation", "restoreDonation", "donationAudit",
  "events",
  "summary",
  "grid",
  "renamePerson",
  "splitIdentities", "splits", "undoSplit",
  "merges",
  "merge",
  "undoMerge",
  "gap",
  "gaps",
  "backup",
  "close",
  "candidatePersons",
  "insights",
  "personsTop",
  "personStats",
  "ensureOwnerIdentity",
]);
parentPort!.on(
  "message",
  async ({
    id,
    method,
    args,
  }: {
    id: number;
    method: string;
    args: unknown[];
  }) => {
    try {
      if (!allowed.has(method)) throw new Error("UNKNOWN_OPERATION");
      const fn = (
        store as unknown as Record<string, (...args: unknown[]) => unknown>
      )[method]!;
      const result = await fn.apply(store, args);
      parentPort!.postMessage({ id, result });
    } catch (error) {
      parentPort!.postMessage({
        id,
        error: error instanceof Error ? error.message : "DB_ERROR",
      });
    }
  },
);
parentPort!.postMessage({ ready: true });
