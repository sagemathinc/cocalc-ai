import { withTimeout } from "@cocalc/util/async-utils";
import type { BrowserExecApi } from "./api-types";

const DEFAULT_BROWSER_EXEC_FS_BOOTSTRAP_TIMEOUT_MS = 10_000;
const DEFAULT_BROWSER_EXEC_FS_CALL_TIMEOUT_MS = 15_000;

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

function normalizeFsCallError(
  err: unknown,
  prop: PropertyKey,
  timeoutMs: number,
): unknown {
  const message = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
  if (!message.includes("timeout")) {
    return err;
  }
  const wrapped = new Error(
    `browser-session fs call '${String(prop)}' timed out after ${timeoutMs}ms`,
  );
  (wrapped as any).cause = err;
  return wrapped;
}

export function createBrowserExecFsApi({
  loadFsClient,
  bootstrapTimeoutMs = DEFAULT_BROWSER_EXEC_FS_BOOTSTRAP_TIMEOUT_MS,
  callTimeoutMs = DEFAULT_BROWSER_EXEC_FS_CALL_TIMEOUT_MS,
  withTimeoutImpl = withTimeout,
}: {
  loadFsClient: () => Promise<any>;
  bootstrapTimeoutMs?: number;
  callTimeoutMs?: number;
  withTimeoutImpl?: WithTimeoutLike;
}): BrowserExecApi["fs"] {
  let fsApiPromise: Promise<any> | undefined;
  const getFsApi = async () => {
    if (!fsApiPromise) {
      fsApiPromise = withTimeoutImpl(
        Promise.resolve(loadFsClient()),
        bootstrapTimeoutMs,
      ).catch((err) => {
        fsApiPromise = undefined;
        throw normalizeFsBootstrapError(err, bootstrapTimeoutMs);
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
          try {
            return await withTimeoutImpl(
              Promise.resolve(value.apply(fs, args)),
              callTimeoutMs,
            );
          } catch (err) {
            throw normalizeFsCallError(err, prop, callTimeoutMs);
          }
        };
      },
    },
  ) as BrowserExecApi["fs"];
}
