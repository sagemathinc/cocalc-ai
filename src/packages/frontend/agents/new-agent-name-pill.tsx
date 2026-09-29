/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useId, useRef, useState } from "react";
import { Popover } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import { Tooltip } from "@cocalc/frontend/components/tip";
import { ComposerPillButton } from "@cocalc/frontend/chat/composer-codex-controls";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { AgentNameInput } from "./agent-name-input";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";

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
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const invalid = !!problem;
  return (
    // The tooltip wraps a span: CoCalc's Tooltip does not forward the
    // popover's click and ref to its child.
    <Tooltip title={problem ?? "Change the agent's name"}>
      <span style={{ display: "inline-flex", minWidth: 0 }}>
        <Popover
          open={open}
          onOpenChange={setOpen}
          afterOpenChange={(visible) => {
            if (visible) document.getElementById(`${id}-name`)?.focus();
          }}
          trigger="click"
          placement="bottomLeft"
          destroyOnHidden
          content={
            <KeyboardBoundary
              id={`${id}-dialog`}
              role="dialog"
              aria-label="Change agent name"
              style={{ width: 280, maxWidth: "calc(100vw - 48px)" }}
              onKeyDown={(event) => {
                if (
                  event.key === "Escape" ||
                  (event.key === "Enter" &&
                    event.target instanceof HTMLInputElement)
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  close();
                }
              }}
            >
              <AgentNameInput
                id={`${id}-name`}
                label="Name"
                value={name}
                onChange={onChange}
                problem={name.trim() ? problem : undefined}
                busy={busy}
              />
            </KeyboardBoundary>
          }
        >
          <ComposerPillButton
            ref={triggerRef}
            aria-label={`Agent name: ${name || "none"}. Change name`}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? `${id}-dialog` : undefined}
            aria-invalid={invalid || undefined}
            disabled={busy}
            style={{
              alignItems: "center",
              color: invalid ? UI_COLORS.danger : UI_COLORS.text,
              display: "inline-flex",
              gap: 4,
              maxWidth: 200,
              minWidth: 0,
            }}
          >
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              @{name || "name"}
            </span>
            <Icon name="pencil" style={{ color: UI_COLORS.secondary }} />
          </ComposerPillButton>
        </Popover>
      </span>
    </Tooltip>
  );
}
