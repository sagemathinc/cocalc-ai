import { withTimeout } from "@cocalc/util/async-utils";
import type { BrowserExecApi } from "./api-types";

const DEFAULT_BROWSER_EXEC_FS_BOOTSTRAP_TIMEOUT_MS = 10_000;

type WithTimeoutLike = <T>(
  promise: Promise<T>,
  timeoutMs: number,
) => Promise<T>;

function normalizeFsBootstrapError(err: unknown, timeoutMs: number): unknown {
  const message = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
  if (!message.includes("timeout")) {
    return err;
  }
  const wrapped = new Error(
    `browser-session fs bootstrap timed out after ${timeoutMs}ms`,
  );
  (wrapped as any).cause = err;
  return wrapped;
}

export function createBrowserExecFsApi({
  loadFsClient,
  timeoutMs = DEFAULT_BROWSER_EXEC_FS_BOOTSTRAP_TIMEOUT_MS,
  withTimeoutImpl = withTimeout,
}: {
  loadFsClient: () => Promise<any>;
  timeoutMs?: number;
  withTimeoutImpl?: WithTimeoutLike;
}): BrowserExecApi["fs"] {
  let fsApiPromise: Promise<any> | undefined;
  const getFsApi = async () => {
    if (!fsApiPromise) {
      fsApiPromise = withTimeoutImpl(
        Promise.resolve(loadFsClient()),
        timeoutMs,
      ).catch((err) => {
        fsApiPromise = undefined;
        throw normalizeFsBootstrapError(err, timeoutMs);
      });
    }
    return await fsApiPromise;
  };

  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        return async (...args) => {
          const fs = await getFsApi();
          const value = (fs as any)[prop];
          if (typeof value !== "function") {
            return value;
          }
          return await value.apply(fs, args);
        };
      },
    },
  ) as BrowserExecApi["fs"];
}
