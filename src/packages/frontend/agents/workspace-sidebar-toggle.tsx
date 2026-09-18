/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Icon, Tooltip } from "@cocalc/frontend/components";
import { Button } from "antd";

export const AGENT_SIDEBAR_ID = "agents-workspace-sidebar";

export function AgentsSidebarToggle({
  hidden,
  onToggle,
}: {
  hidden: boolean;
  onToggle: () => void;
}) {
  const label = hidden ? "Show Agents sidebar" : "Hide Agents sidebar";
  return (
    <Tooltip title={label}>
      <Button
        type="text"
        aria-controls={AGENT_SIDEBAR_ID}
        aria-expanded={!hidden}
        aria-label={label}
        icon={<Icon name={hidden ? "chevron-right" : "chevron-left"} />}
        onClick={onToggle}
      />
    </Tooltip>
  );
}
