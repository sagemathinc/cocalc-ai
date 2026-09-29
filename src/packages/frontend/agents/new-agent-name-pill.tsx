/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useState } from "react";
import { Popover } from "antd";
import { Tooltip } from "@cocalc/frontend/components/tip";
import { ComposerPillButton } from "@cocalc/frontend/chat/composer-codex-controls";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { AgentNameInput } from "./agent-name-input";

// The agent's name, auto-generated and easy to change later, as a pill in
// the settings line. An invalid name is flagged on the pill itself.
export function NewAgentNamePill({
  name,
  onChange,
  problem,
  busy,
}: {
  name: string;
  onChange: (name: string) => void;
  problem?: string;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const invalid = !!problem;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomLeft"
      content={
        <div style={{ width: 280 }}>
          <AgentNameInput
            id="new-agent-name"
            label="Name"
            value={name}
            onChange={onChange}
            problem={name.trim() ? problem : undefined}
            busy={busy}
            onEnter={() => setOpen(false)}
          />
        </div>
      }
    >
      <Tooltip title={problem ?? "Change the agent's name"}>
        <ComposerPillButton
          aria-label={`Agent name: ${name || "none"}. Change name`}
          aria-haspopup="dialog"
          aria-invalid={invalid || undefined}
          disabled={busy}
          style={{
            color: invalid ? UI_COLORS.danger : undefined,
            maxWidth: 180,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          @{name || "name"}
        </ComposerPillButton>
      </Tooltip>
    </Popover>
  );
}
