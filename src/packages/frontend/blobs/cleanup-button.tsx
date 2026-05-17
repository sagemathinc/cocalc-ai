/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  InputNumber,
  message,
  Popconfirm,
  Space,
  Typography,
} from "antd";
import { useState } from "react";

import { Icon } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { humanSize } from "@cocalc/util/misc";

const { Text } = Typography;

const DEFAULT_DELETE_LIMIT = 100;
const MAX_DELETE_LIMIT = 1000;

interface Summary {
  deleted_count: number;
  deleted_bytes: number;
}

interface Props {
  project_id?: string;
  mode: "account" | "project";
}

function title(mode: Props["mode"]) {
  return mode === "account"
    ? "Delete oldest account blobs"
    : "Delete oldest project blobs";
}

function description(mode: Props["mode"]) {
  if (mode === "account") {
    return "Free account blob quota by deleting the oldest blobs attributed to your account.";
  }
  return "Free project blob quota by deleting the oldest blobs attributed to this project.";
}

export function BlobCleanupButton({ mode, project_id }: Props) {
  const [limit, setLimit] = useState(DEFAULT_DELETE_LIMIT);
  const [busy, setBusy] = useState(false);
  const [lastSummary, setLastSummary] = useState<Summary | null>(null);

  async function run() {
    setBusy(true);
    setLastSummary(null);
    try {
      const count = Math.max(1, Math.min(MAX_DELETE_LIMIT, Math.floor(limit)));
      const result =
        mode === "account"
          ? await webapp_client.conat_client.hub.db.deleteOldestAccountBlobs({
              limit: count,
            })
          : await webapp_client.conat_client.hub.db.deleteOldestProjectBlobs({
              project_id: project_id!,
              limit: count,
            });
      setLastSummary(result);
      void message.success(
        `Deleted ${result.deleted_count} blob${
          result.deleted_count === 1 ? "" : "s"
        } and freed ${humanSize(result.deleted_bytes)}.`,
      );
    } catch (err) {
      void message.error(`Failed to delete blobs: ${err}`);
    } finally {
      setBusy(false);
    }
  }

  if (mode === "project" && !project_id) {
    return null;
  }

  return (
    <Alert
      type="info"
      showIcon
      icon={<Icon name="database" />}
      message={title(mode)}
      description={
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          <Text>{description(mode)}</Text>
          <Space wrap>
            <Text>Delete oldest</Text>
            <InputNumber
              min={1}
              max={MAX_DELETE_LIMIT}
              value={limit}
              onChange={(value) =>
                setLimit(
                  Math.max(1, Math.min(MAX_DELETE_LIMIT, Number(value) || 1)),
                )
              }
            />
            <Text>blob records.</Text>
            <Popconfirm
              title={title(mode)}
              description="This permanently removes those blob records. Existing notebooks or chat messages that reference them may show broken images or missing attachments."
              okText="Delete blobs"
              okButtonProps={{ danger: true }}
              onConfirm={run}
            >
              <Button danger loading={busy} disabled={busy}>
                Delete Oldest Blobs
              </Button>
            </Popconfirm>
          </Space>
          {lastSummary && (
            <Text type="secondary">
              Last cleanup deleted {lastSummary.deleted_count} blob
              {lastSummary.deleted_count === 1 ? "" : "s"} and freed{" "}
              {humanSize(lastSummary.deleted_bytes)}.
            </Text>
          )}
        </Space>
      }
    />
  );
}
