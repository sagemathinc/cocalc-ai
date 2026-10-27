/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AcpStreamMessage } from "@cocalc/conat/ai/acp/types";
import type { SiteFundedTurnUsageWarning } from "@cocalc/util/ai/site-funded-codex";

/** The turn's warning that the account is close to an included-AI limit. */
export function latestUsageWarning(
  events: readonly AcpStreamMessage[] | null | undefined,
): SiteFundedTurnUsageWarning | undefined {
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
    const message = events![i];
    if (message?.type !== "event" || message.event?.type !== "usage_warning") {
      continue;
    }
    const { window, threshold } = message.event;
    if (window !== "5h" && window !== "7d") return;
    return { window, threshold: threshold === 95 ? 95 : 80 };
  }
}
