import { Worker } from "node:worker_threads";
export class StoreClient {
  private worker: Worker;
  private sequence = 0;
  private dead = false;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly ready: Promise<void>;
  constructor(path: string) {
    this.worker = new Worker(new URL("./db-worker.js", import.meta.url), {
      workerData: { path },
    });
    this.ready = new Promise((resolve, reject) => {
      this.worker.on("message", (message) => {
        if (message.ready) {
          resolve();
          return;
        }
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.result);
      });
      this.worker.on("error", (error) => {
        this.dead = true;
        reject(error);
        for (const p of this.pending.values()) p.reject(error);
        this.pending.clear();
      });
      this.worker.on("exit", () => {
        this.dead = true;
        for (const p of this.pending.values())
          p.reject(new Error("DB_WORKER_STOPPED"));
        this.pending.clear();
      });
    });
  }
  async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    await this.ready;
    if (this.dead) throw new Error("DB_WORKER_STOPPED");
    if (this.pending.size >= 10_000) throw new Error("QUEUE_OVERFLOW");
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        this.worker.postMessage({ id, method, args });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async stop(): Promise<void> {
    if (this.dead) return;
    await this.call("close");
    await this.worker.terminate();
  }
}
