// Bound export startup independently of the notebook's background reconnect loop.
export const EXPORT_STARTUP_TIMEOUT_MS = 30_000;
const RETRY_MS = 3000;

function accessDenied(error: any): boolean {
  const code = error?.code ?? error?.statusCode ?? error?.status;
  return (
    [401, 403, "401", "403", "EACCES", "EPERM"].includes(code) ||
    /permission denied|access denied|not authorized|unauthorized|forbidden|\b40[13]\b/i.test(
      String(error),
    )
  );
}

export function initializeExport(
  start: () => Promise<unknown>,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let lastError: unknown;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(retry);
      signal.removeEventListener("abort", cancel);
      if (error) reject(error);
      else resolve();
    };
    const cancel = () => finish(new Error("Export startup cancelled."));
    // This timer also bounds an RPC that never settles; a late response cannot
    // resolve this attempt or schedule another retry.
    const deadline = setTimeout(() => {
      finish(
        new Error(
          "Jupyter export startup timed out after 30 seconds. No conversion was requested. " +
            "Check that the project is running and connected, then retry. " +
            "For PDF, you can also use the browser-print PDF option." +
            (lastError == null ? "" : ` Last startup error: ${lastError}`),
        ),
      );
    }, EXPORT_STARTUP_TIMEOUT_MS);
    const attempt = async () => {
      try {
        await start();
        finish();
      } catch (error) {
        if (settled) return;
        lastError = error;
        if (accessDenied(error)) {
          finish(
            new Error(
              `Jupyter export startup was denied. Check your sign-in and project access before retrying. No conversion was requested. Details: ${error}`,
            ),
          );
        } else {
          retry = setTimeout(attempt, RETRY_MS);
        }
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    else void attempt();
  });
}
