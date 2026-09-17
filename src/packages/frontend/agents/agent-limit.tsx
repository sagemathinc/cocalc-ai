/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button } from "antd";
import type { NamedAgentDirectory } from "@cocalc/conat/agents/personal";
import { openAccountSettings } from "@cocalc/frontend/account/settings-routing";

export const NAMED_AGENT_LIMIT_ERROR = "named_agent_limit_reached";

export function namedAgentLimitReached(
  directory: NamedAgentDirectory | undefined,
): boolean {
  const usage = directory?.usage;
  return !!usage && usage.active >= usage.limit;
}

export function isNamedAgentLimitError(error: unknown): boolean {
  return `${error}`.includes(NAMED_AGENT_LIMIT_ERROR);
}

export function NamedAgentLimitAlert({
  directory,
}: {
  directory: NamedAgentDirectory | undefined;
}) {
  const usage = directory?.usage;
  if (!usage || usage.active < usage.limit) return null;
  return (
    <Alert
      type="warning"
      showIcon
      title={`You are using ${usage.active} of ${usage.limit} named agents`}
      description="Remove an agent from Agents to free a slot, or upgrade your membership to add more. Existing agents keep working after a membership downgrade."
      action={
        <Button
          type="primary"
          onClick={() =>
            openAccountSettings(
              { page: "membership" },
              { openMembershipPlanChooser: true },
            )
          }
        >
          Upgrade membership
        </Button>
      }
    />
  );
}
