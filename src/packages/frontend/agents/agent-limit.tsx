/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useState } from "react";
import { Alert, Button, Modal, Space } from "antd";
import type { NamedAgentDirectory } from "@cocalc/conat/agents/personal";
import { openAccountSettings } from "@cocalc/frontend/account/settings-routing";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

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

export function NamedAgentUsage({
  directory,
}: {
  directory: NamedAgentDirectory | undefined;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const usage = directory?.usage;
  if (!usage || usage.active >= usage.limit) return null;
  return (
    <>
      <Button
        type="link"
        size="small"
        aria-label={`${usage.active} of ${usage.limit} named-agent slots used. Learn how to free slots`}
        style={{
          color: UI_COLORS.muted,
          height: "auto",
          padding: 0,
          textDecoration: "underline",
          whiteSpace: "normal",
        }}
        onClick={() => setDetailsOpen(true)}
      >
        {usage.active} of {usage.limit} named-agent slots used
      </Button>
      <Modal
        open={detailsOpen}
        title="Named-agent slots"
        onCancel={() => setDetailsOpen(false)}
        modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
        footer={
          <Space wrap>
            <Button onClick={() => setDetailsOpen(false)}>Close</Button>
            <Button
              onClick={() => {
                setDetailsOpen(false);
                openAccountSettings({ page: "membership" });
              }}
            >
              Review membership
            </Button>
            <Button
              type="primary"
              onClick={() => {
                setDetailsOpen(false);
                openAccountSettings({ page: "my-agents" });
              }}
            >
              Manage named agents
            </Button>
          </Space>
        }
      >
        <p>
          Each active named agent uses one slot. You are currently using{" "}
          <strong>{usage.active}</strong> of <strong>{usage.limit}</strong>.
        </p>
        <p>To free a slot:</p>
        <ol>
          <li>Open Manage named agents.</li>
          <li>Find an agent you no longer need.</li>
          <li>Choose Remove from Agents and confirm.</li>
        </ol>
        <p>
          Removing an agent from Agents does not delete its project,
          conversation, or artifacts. Historical Agent Network records remain,
          but the agent can no longer receive network messages unless it is
          named again.
        </p>
        <Alert
          type="info"
          showIcon
          title="Hiding an agent does not free a slot"
          description="Hide from Agents only removes the agent from the visible sidebar. Use Remove from Agents to release its slot."
        />
      </Modal>
    </>
  );
}
