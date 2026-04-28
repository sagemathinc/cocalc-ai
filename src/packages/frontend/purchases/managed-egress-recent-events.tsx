/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Modal, Space, Tag, Typography } from "antd";
import type { ReactElement } from "react";
import { useState } from "react";

import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { capitalize, humanSize } from "@cocalc/util/misc";
import type { ManagedEgressEventSummary } from "@cocalc/conat/hub/api/purchases";

const { Text } = Typography;

export function formatManagedEgressCategory(category: string): string {
  if (category === "file-download") return "File downloads";
  if (category === "http-proxy") return "App server HTTP traffic";
  if (category === "ws-proxy") return "App server WebSocket traffic";
  if (category === "ssh") return "SSH traffic";
  if (category === "interactive-conat") return "Interactive session traffic";
  if (category === "raw-network") return "Project outbound network traffic";
  return capitalize(category.replace(/[-_]/g, " "));
}

function getManagedEgressRequestPath(
  event: ManagedEgressEventSummary,
): string | undefined {
  const value = event.metadata?.request_path;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function getManagedEgressEventProjectLabel(
  event: ManagedEgressEventSummary,
): string {
  return (
    `${event.project_title ?? event.project_id ?? ""}`.trim() ||
    "Account-wide session traffic"
  );
}

export function ManagedEgressRecentEventsButton({
  events,
}: {
  events?: ManagedEgressEventSummary[];
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  if (!events || events.length === 0) {
    return null;
  }
  return (
    <>
      <Button size="small" onClick={() => setOpen(true)}>
        View recent events ({events.length})
      </Button>
      <Modal
        title="Recent managed egress events"
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width={760}
        bodyStyle={{ maxHeight: 420, overflowY: "auto" }}
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          {events.map((event, i) => {
            const requestPath = getManagedEgressRequestPath(event);
            return (
              <div
                key={`${event.occurred_at}-${event.project_id ?? "none"}-${i}`}
              >
                <Space wrap>
                  <Tag>{formatManagedEgressCategory(event.category)}</Tag>
                  <Tag>{humanSize(event.bytes)}</Tag>
                  <Text>{getManagedEgressEventProjectLabel(event)}</Text>
                  <Text type="secondary">
                    <TimeAgo date={event.occurred_at} />
                  </Text>
                </Space>
                {requestPath ? (
                  <div style={{ marginTop: "4px" }}>
                    <Text code>{requestPath}</Text>
                  </div>
                ) : null}
              </div>
            );
          })}
        </Space>
      </Modal>
    </>
  );
}
