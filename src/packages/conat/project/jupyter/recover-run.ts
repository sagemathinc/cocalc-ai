/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { OutputMessage } from "./run-code";
import type { JupyterLiveRunPage } from "./live-run";

export async function* recoverRunOutput({
  source,
  runId,
  readPage,
  signal,
  pollMs = 1000,
}: {
  source: AsyncIterable<OutputMessage[]> & { readonly replayCursor?: number };
  runId: string;
  readPage: (after: number) => Promise<JupyterLiveRunPage | null>;
  signal: AbortSignal;
  pollMs?: number;
}): AsyncGenerator<OutputMessage[]> {
  let interruption: unknown;
  try {
    yield* source;
    return;
  } catch (error) {
    if (signal.aborted) return;
    if (
      (error as any)?.code !== "JUPYTER_RUN_TRANSPORT_LOST" ||
      (error as any)?.run_id !== runId ||
      source.replayCursor == null
    )
      throw error;
    interruption = error;
  }
  let cursor = source.replayCursor!;
  while (!signal.aborted) {
    // This callback only reads retained output; it must never restart execution.
    let page: JupyterLiveRunPage | null;
    try {
      page = await readPage(cursor);
    } catch (cause) {
      if (signal.aborted) return;
      throw Object.assign(new Error("Jupyter output recovery failed"), {
        cause,
        code: "JUPYTER_RUN_RECOVERY_FAILED",
        run_id: runId,
      });
    }
    if (signal.aborted) return;
    if (page == null) throw interruption;
    if (page.run_id !== runId) throw Error("Jupyter replay run mismatch");
    const previous = cursor;
    for (const batch of page.batches) {
      if (batch.run_id !== runId || batch.seq !== cursor + 1) {
        throw Error("Jupyter replay output gap or duplicate");
      }
      if (batch.mesgs.some((message) => message.run_id !== runId)) {
        throw Error("Jupyter replay message run mismatch");
      }
      if (signal.aborted) return;
      cursor = batch.seq;
      yield batch.mesgs as OutputMessage[];
    }
    if (page.next_seq !== cursor || (page.has_more && cursor === previous)) {
      throw Error("Jupyter replay cursor did not advance consistently");
    }
    if (!page.has_more && page.done) return;
    if (!page.has_more && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, pollMs);
        signal.addEventListener("abort", finish, { once: true });
      });
    }
  }
}
