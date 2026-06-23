/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { waitForCompletion } from "@cocalc/conat/lro/client";
import { getLro } from "@cocalc/server/lro/lro-db";

type WaitForCompletionOptions = Parameters<typeof waitForCompletion>[0];

export async function waitForDurableLroCompletion(
  opts: WaitForCompletionOptions,
): ReturnType<typeof waitForCompletion> {
  const callerGetSummary = opts.getSummary;
  return await waitForCompletion({
    ...opts,
    getSummary: async () => {
      const summary = await callerGetSummary?.();
      if (summary != null) {
        return summary;
      }
      if (!opts.op_id) {
        return undefined;
      }
      return await getLro(opts.op_id);
    },
  });
}
