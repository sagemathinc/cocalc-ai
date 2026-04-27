/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Modal, Space, Tag, Typography } from "antd";
import type { ReactElement } from "react";
import { useState } from "react";

import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { capitalize } from "@cocalc/util/misc";
import type { ManagedEgressEventSummary } from "@cocalc/conat/hub/api/purchases";

const { Text } = Typography;

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = Number.isInteger(value) || value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatManagedEgressCategory(category: string): string {
  if (category === "file-download") return "File downloads";
  return capitalize(category.replace(/[-_]/g, " "));
}

function getManagedEgressRequestPath(
  event: ManagedEgressEventSummary,
): string | undefined {
  const value = event.metadata?.request_path;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
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
              <div key={`${event.occurred_at}-${event.project_id}-${i}`}>
                <Space wrap>
                  <Tag>{formatManagedEgressCategory(event.category)}</Tag>
                  <Tag>{formatBytes(event.bytes)}</Tag>
                  <Text>{event.project_title ?? event.project_id}</Text>
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
