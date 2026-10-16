/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AgentNetworkSelf } from "@cocalc/conat/agents/personal";

const MAX_NETWORKS = 5;
const MAX_TITLE = 80;

/** Turn context line naming the @name peers use for this agent. */
export function agentNetworkSelfContext(
  self?: AgentNetworkSelf,
): string | undefined {
  const name = `${self?.name ?? ""}`.trim();
  if (!name || !self?.networks?.length) return undefined;
  const networks = self.networks
    .slice(0, MAX_NETWORKS)
    .map(
      ({ title, delivery_mode }) =>
        `${JSON.stringify(`${title}`.slice(0, MAX_TITLE))} (${delivery_mode} delivery)`,
    )
    .join(", ");
  const more =
    self.networks.length > MAX_NETWORKS
      ? ` and ${self.networks.length - MAX_NETWORKS} more`
      : "";
  return `Agent identity: in Agent Network ${networks}${more}, you are @${name}. Peers see your messages as from @${name}; refer to and sign as yourself with that name.`;
}
