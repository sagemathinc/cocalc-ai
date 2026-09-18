/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Icon } from "@cocalc/frontend/components";
import { Button } from "antd";

export function AgentWorkspaceCloseButton({
  agentPath,
  color,
  onClose,
}: {
  agentPath: string;
  color: string;
  onClose: () => void;
}) {
  return (
    <Button
      type="text"
      icon={<Icon name="times" />}
      aria-label={`Close workspace for ${agentPath}`}
      title="Close this mounted workspace view"
      onClick={onClose}
      style={{ color }}
    />
  );
}
