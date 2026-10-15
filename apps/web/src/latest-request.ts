/** One owner per mounted resource. Superseded responses never update its view. */
export function latestRequest() {
  let controller: AbortController | undefined;
  return {
    async run<T>(load: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void, fail: (error: Error) => void = () => {}) {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        const value = await load(current.signal);
        if (!current.signal.aborted) apply(value);
      } catch (error) {
        if (!current.signal.aborted) fail(error instanceof Error ? error : new Error(String(error)));
      }
    },
    cancel() { controller?.abort(); },
  };
}
