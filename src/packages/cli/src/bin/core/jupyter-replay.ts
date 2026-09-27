import type { JupyterClient } from "@cocalc/conat/project/jupyter/run-code";

type ReplayClient = Pick<JupyterClient, "getRun" | "close"> & {
  socket: { state: string };
};

export function createJupyterReplayReader({
  createClient,
  runId,
  signal,
  timeoutMs = 5000,
}: {
  createClient: () => ReplayClient;
  runId: string;
  signal: AbortSignal;
  timeoutMs?: number;
}) {
  let client: ReplayClient | undefined;
  let closed = false;
  let cancel: ((error: unknown) => void) | undefined;
  const dispose = () => {
    const previous = client;
    client = undefined;
    previous?.close();
  };
  return {
    close: () => {
      closed = true;
      cancel?.(new Error("Jupyter replay reader closed"));
      dispose();
    },
    readPage: async (after_seq: number) => {
      signal.throwIfAborted();
      if (closed) throw Error("Jupyter replay reader closed");
      if (cancel) throw Error("Jupyter replay read already active");
      let stopped = false;
      const deadline = Date.now() + timeoutMs;
      const interrupted = new Promise<never>((_, reject) => {
        cancel = (error) => {
          stopped = true;
          reject(error);
          dispose();
        };
      });
      const abort = () => cancel?.(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      // Transport timeouts can be repeated during readiness/reconnect. This
      // deadline covers the complete read, including its one safe retry.
      const timer = setTimeout(
        () =>
          cancel?.(
            Object.assign(Error("Jupyter replay read timed out"), {
              code: 408,
            }),
          ),
        timeoutMs,
      );
      try {
        return await Promise.race([
          interrupted,
          (async () => {
            for (let attempt = 0; ; attempt++) {
              if (!client || client.socket.state === "closed") {
                dispose();
                client = createClient();
              }
              const current = client;
              try {
                return await current.getRun(
                  runId,
                  { after_seq },
                  { timeout: Math.max(1, deadline - Date.now()) },
                );
              } catch (error) {
                if (
                  stopped ||
                  closed ||
                  signal.aborted ||
                  attempt !== 0 ||
                  Date.now() >= deadline ||
                  ["401", "403"].includes(String((error as any)?.code)) ||
                  !["closed", "disconnected"].includes(current.socket.state)
                )
                  throw error;
                // Only retained output is read; execution is never retried.
                dispose();
              }
            }
          })(),
        ]);
      } finally {
        stopped = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        cancel = undefined;
      }
    },
  };
}
