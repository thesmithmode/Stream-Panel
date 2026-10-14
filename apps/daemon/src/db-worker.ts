import { parentPort, workerData } from "node:worker_threads";
import {isStoreMethod} from "./store-contract.js";
import { StreamStore } from "../../../packages/core/src/store.js";
const store = new StreamStore(String(workerData.path), workerData.profile);
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
      if (!isStoreMethod(method)) throw new Error("UNKNOWN_OPERATION");
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
