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

function siteLicenseGrantMessage(
  grant:
    | {
        granted: boolean;
        message?: string;
        membership_class?: string | null;
      }
    | null
    | undefined,
): string {
  return (
    grant?.message ??
    (grant?.granted
      ? `Temporary ${grant.membership_class ?? "site-license"} membership granted.`
      : "")
  );
}

export function PublicDirectoryShareBanner({
  share,
}: {
  share: ResolvedPublicDirectoryShare;
}) {
  const projectActions = useActions("projects");
  const [open, setOpen] = useState(false);
  const [copyMode, setCopyMode] = useState<"new" | "existing">("new");
  const [destinationProjectId, setDestinationProjectId] = useState("");
  const [destinationPath, setDestinationPath] = useState(".");
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [copyMessage, setCopyMessage] = useState("");

  function openCopyModal() {
    setCopyMode("new");
    setCopyError("");
    setCopyMessage("");
    setOpen(true);
  }

  async function copyToNewProject() {
    setCopying(true);
    setCopyError("");
    setCopyMessage("");
    try {
      const result =
        await webapp_client.conat_client.hub.publicDirectoryShares.copyToNewProject(
          {
            slug: share.slug,
            options: { recursive: true },
          },
        );
      const grantMessage = siteLicenseGrantMessage(result.site_license_grant);
      setCopyMessage(
        `New project created and copy queued as operation ${result.op_id}.${grantMessage ? ` ${grantMessage}` : ""}`,
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
      const grantMessage = siteLicenseGrantMessage(result.site_license_grant);
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
        title={
          <Space wrap>
            <Text strong>{shareTitle(share)}</Text>
            <Text>This is a published, read-only folder.</Text>
            <Tag>{share.slug}</Tag>
            {share.site_license_grant_on_copy ? (
              <Tag color="blue">temporary membership on copy</Tag>
            ) : null}
            <Button size="small" type="primary" onClick={openCopyModal}>
              Copy
            </Button>
          </Space>
        }
      />
      <Modal
        title="Copy published folder"
        open={open}
        onCancel={() => setOpen(false)}
        footer={
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <Button
              onClick={() =>
                setCopyMode(copyMode === "new" ? "existing" : "new")
              }
            >
              {copyMode === "new"
                ? "Copy to existing project"
                : "Create a new project instead"}
            </Button>
            <Space>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                type="primary"
                loading={copying}
                disabled={
                  copyMode === "existing" && !destinationProjectId.trim()
                }
                onClick={() =>
                  void (copyMode === "new"
                    ? copyToNewProject()
                    : copyToProject())
                }
              >
                {copyMode === "new"
                  ? "Create project and copy"
                  : "Copy to project"}
              </Button>
            </Space>
          </div>
        }
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          {share.description ? <Text>{share.description}</Text> : null}
          {copyMode === "new" ? (
            <Text>
              CoCalc will create a new project and copy this published folder
              into it.
            </Text>
          ) : null}
          {share.site_license_grant_on_copy ? (
            <Alert
              type="success"
              showIcon
              title="Temporary membership offered"
              description={formatMembershipGrantDescription(share)}
            />
          ) : null}
          {copyMode === "existing" ? (
            <>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>
                  Destination project
                </div>
                <SelectProject
                  value={destinationProjectId}
                  onChange={(projectId) =>
                    setDestinationProjectId(projectId ?? "")
                  }
                />
              </div>
              <Input
                placeholder="Destination path"
                value={destinationPath}
                onChange={(e) => setDestinationPath(e.target.value)}
              />
            </>
          ) : null}
          {copyMessage ? (
            <Alert type="success" showIcon title={copyMessage} />
          ) : null}
          {copyError ? <Alert type="error" showIcon title={copyError} /> : null}
        </Space>
      </Modal>
    </>
  );
}
