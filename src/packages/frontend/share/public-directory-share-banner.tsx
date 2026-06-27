/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Input, Modal, Space, Tag, Typography } from "antd";
import { useState } from "react";

import type { ResolvedPublicDirectoryShare } from "@cocalc/conat/hub/api/public-directory-shares";
import { useActions } from "@cocalc/frontend/app-framework";
import { SelectProject } from "@cocalc/frontend/projects/select-project";
import { normalizeUserFacingError } from "@cocalc/frontend/components/user-facing-error";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const { Text } = Typography;

function formatMembershipGrantDescription(
  share: ResolvedPublicDirectoryShare,
): string {
  const tier = share.site_license_membership_tier_id || "site-license";
  const days = share.site_license_duration_days ?? 30;
  return `Copying this share attempts to grant a temporary ${tier} membership for ${days} ${days === 1 ? "day" : "days"}. If no seats are available, the copy still works on the free tier.`;
}

function shareTitle(share: ResolvedPublicDirectoryShare): string {
  return share.title?.trim() || share.slug;
}

export function PublicDirectoryShareBanner({
  share,
}: {
  share: ResolvedPublicDirectoryShare;
}) {
  const projectActions = useActions("projects");
  const [open, setOpen] = useState(false);
  const [destinationProjectId, setDestinationProjectId] = useState("");
  const [destinationPath, setDestinationPath] = useState(".");
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [copyMessage, setCopyMessage] = useState("");

  async function copyToProject() {
    if (!destinationProjectId.trim()) return;
    setCopying(true);
    setCopyError("");
    setCopyMessage("");
    try {
      const result =
        await webapp_client.conat_client.hub.publicDirectoryShares.copyToProject(
          {
            slug: share.slug,
            destination_project_id: destinationProjectId.trim(),
            destination_path: destinationPath.trim() || ".",
            options: { recursive: true },
          },
        );
      const grant = result.site_license_grant;
      const grantMessage =
        grant?.message ??
        (grant?.granted
          ? `Temporary ${grant.membership_class ?? "site-license"} membership granted.`
          : "");
      setCopyMessage(
        `Copy queued as operation ${result.op_id}.${grantMessage ? ` ${grantMessage}` : ""}`,
      );
      projectActions.open_project({
        project_id: result.destination_project_id,
        switch_to: true,
        target: "files",
      });
    } catch (err) {
      setCopyError(normalizeUserFacingError(err).message);
    } finally {
      setCopying(false);
    }
  }

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ borderRadius: 0 }}
        message={
          <Space wrap>
            <Text strong>{shareTitle(share)}</Text>
            <Text>This is a published, read-only folder.</Text>
            <Tag>{share.slug}</Tag>
            {share.site_license_grant_on_copy ? (
              <Tag color="blue">temporary membership on copy</Tag>
            ) : null}
            <Button size="small" type="primary" onClick={() => setOpen(true)}>
              Copy to my project
            </Button>
          </Space>
        }
      />
      <Modal
        title="Copy published folder"
        open={open}
        okText="Copy published folder"
        confirmLoading={copying}
        okButtonProps={{ disabled: !destinationProjectId.trim() }}
        onOk={() => void copyToProject()}
        onCancel={() => setOpen(false)}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          {share.description ? <Text>{share.description}</Text> : null}
          {share.site_license_grant_on_copy ? (
            <Alert
              type="success"
              showIcon
              message="Temporary membership offered"
              description={formatMembershipGrantDescription(share)}
            />
          ) : null}
          <div>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>
              Destination project
            </div>
            <SelectProject
              value={destinationProjectId}
              onChange={(projectId) => setDestinationProjectId(projectId ?? "")}
            />
          </div>
          <Input
            placeholder="Destination path"
            value={destinationPath}
            onChange={(e) => setDestinationPath(e.target.value)}
          />
          {copyMessage ? (
            <Alert type="success" showIcon message={copyMessage} />
          ) : null}
          {copyError ? (
            <Alert type="error" showIcon message={copyError} />
          ) : null}
        </Space>
      </Modal>
    </>
  );
}
