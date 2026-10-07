import { parentPort, workerData } from "node:worker_threads";
import { StreamStore } from "../../../packages/core/src/store.js";
const store = new StreamStore(String(workerData.path));
const allowed = new Set([
  "ingest",
  "sessions",
  "startSession",
  "endSession",
  "recordPoll",
  "updateChatterNames",
  "persons",
  "person",
  "events",
  "summary",
  "grid",
  "renamePerson",
  "splitIdentities",
  "merges",
  "merge",
  "undoMerge",
  "gap",
  "gaps",
  "backup",
  "close",
  "candidatePersons",
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
