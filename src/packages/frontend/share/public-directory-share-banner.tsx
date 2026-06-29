/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Input, Modal, Space, Tag, Typography } from "antd";
import { useState } from "react";

import type { LroEvent } from "@cocalc/conat/hub/api/lro";
import type { ResolvedPublicDirectoryShare } from "@cocalc/conat/hub/api/public-directory-shares";
import { useActions } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { blobImageUrl } from "@cocalc/frontend/components/theme-image-input";
import { SelectProject } from "@cocalc/frontend/projects/select-project";
import { normalizeUserFacingError } from "@cocalc/frontend/components/user-facing-error";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { COLORS } from "@cocalc/util/theme";

const { Paragraph, Text } = Typography;

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

function shareScopeDescription(share: ResolvedPublicDirectoryShare): string {
  return share.path === "."
    ? "This is a published, read-only project."
    : "This is a published, read-only folder.";
}

function sharePublisherLine(share: ResolvedPublicDirectoryShare): string {
  const parts: string[] = [];
  const projectTitle = share.project_title?.trim();
  if (projectTitle) {
    parts.push(`Published from ${projectTitle}`);
  }
  const publisher = share.created_by?.trim() || share.updated_by?.trim();
  if (publisher) {
    parts.push(`Publisher ${publisher}`);
  }
  return parts.join(" · ");
}

function shareImageUrl(
  share: ResolvedPublicDirectoryShare,
): string | undefined {
  const value = (share.theme?.image_blob ?? share.image)?.trim();
  if (!value) return;

  // Uploaded theme images are stored as blob UUIDs.
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    return blobImageUrl(value, "public-share-theme.png");
  }

  try {
    const base =
      typeof window === "undefined"
        ? "https://cocalc.com"
        : window.location.origin;
    const url = new URL(value, base);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return value;
    }
  } catch {
    return;
  }
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

function formatCopyProgress(
  event: Extract<LroEvent, { type: "progress" }>,
): string {
  const phase = event.phase ? `${event.phase}: ` : "";
  const message = event.message || "copying files";
  const progress =
    typeof event.progress === "number" ? ` (${event.progress}%)` : "";
  return `${phase}${message}${progress}`;
}

async function waitForProjectReadable(project_id: string): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    try {
      await webapp_client.conat_client.hub.projects.getProjectRegion({
        project_id,
      });
      return true;
    } catch (err) {
      if (i === 19) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return false;
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
  const [copyProgress, setCopyProgress] = useState("");
  const [placementMessage, setPlacementMessage] = useState("");
  const title = shareTitle(share);
  const publisher = sharePublisherLine(share);
  const image = shareImageUrl(share);
  const description = share.description?.trim();
  const license = share.license?.trim();
  const themeColor = share.theme?.color?.trim() || COLORS.ANTD_LINK_BLUE;
  const themeAccent = share.theme?.accent_color?.trim();
  const themeIcon = share.theme?.icon?.trim() || "folder-open";

  function openCopyModal() {
    setCopyMode("new");
    setCopyError("");
    setCopyMessage("");
    setCopyProgress("");
    setPlacementMessage("");
    setOpen(true);
  }

  async function copyToNewProject() {
    setCopying(true);
    setCopyError("");
    setCopyMessage("");
    setCopyProgress("Creating project...");
    setPlacementMessage("");
    try {
      const result =
        await webapp_client.conat_client.hub.publicDirectoryShares.copyToNewProject(
          {
            slug: share.slug,
            options: { recursive: true },
          },
        );
      if (
        result.requested_host_id &&
        result.placed_on_requested_host === false
      ) {
        setPlacementMessage(
          result.host_placement_message
            ? `The source host was not available for the new project, so CoCalc placed it on another host. Cross-host copy can take longer. Placement detail: ${result.host_placement_message}`
            : "The source host was not available for the new project, so CoCalc placed it on another host. Cross-host copy can take longer.",
        );
      }
      setCopyProgress("Copying files...");
      const summary = await webapp_client.conat_client.lroWait({
        op_id: result.op_id,
        scope_type: result.scope_type,
        scope_id: result.scope_id,
        onProgress: (event) => {
          setCopyProgress(formatCopyProgress(event));
        },
      });
      if (summary.status !== "succeeded") {
        throw new Error(summary.error ?? `Copy ${summary.status}`);
      }
      const grantMessage = siteLicenseGrantMessage(result.site_license_grant);
      setCopyProgress("Waiting for the new project to appear...");
      const canOpen = await waitForProjectReadable(
        result.destination_project_id,
      );
      setCopyMessage(
        canOpen
          ? `New project created and copied.${grantMessage ? ` ${grantMessage}` : ""}`
          : `New project created and copied, but it is not yet available in your project list. Try opening it again in a moment.${grantMessage ? ` ${grantMessage}` : ""}`,
      );
      if (canOpen) {
        projectActions.open_project({
          project_id: result.destination_project_id,
          switch_to: true,
          target: "files",
        });
      }
    } catch (err) {
      setCopyError(normalizeUserFacingError(err).message);
    } finally {
      setCopying(false);
      setCopyProgress("");
    }
  }

  async function copyToProject() {
    if (!destinationProjectId.trim()) return;
    setCopying(true);
    setCopyError("");
    setCopyMessage("");
    setCopyProgress("");
    setPlacementMessage("");
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
        style={{
          background: themeAccent ? `${themeAccent}22` : undefined,
          borderLeft: `4px solid ${themeColor}`,
          borderRadius: 0,
        }}
        title={
          <div
            style={{
              alignItems: "center",
              display: "flex",
              gap: 12,
              width: "100%",
            }}
          >
            {image ? (
              <img
                alt={title}
                src={image}
                style={{
                  border: `1px solid ${COLORS.GRAY_LL}`,
                  borderRadius: 6,
                  height: 56,
                  objectFit: "cover",
                  width: 84,
                }}
              />
            ) : (
              <div
                style={{
                  alignItems: "center",
                  background: themeAccent ?? COLORS.GRAY_LL,
                  border: `1px solid ${COLORS.GRAY_LL}`,
                  borderRadius: 6,
                  color: themeColor,
                  display: "flex",
                  height: 56,
                  justifyContent: "center",
                  width: 56,
                }}
              >
                <Icon name={themeIcon as any} style={{ fontSize: 24 }} />
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <Space wrap>
                <Text strong>{title}</Text>
                <Text>{shareScopeDescription(share)}</Text>
                <Tag>{share.slug}</Tag>
                {share.site_license_grant_on_copy ? (
                  <Tag color="blue">temporary membership on copy</Tag>
                ) : null}
              </Space>
              {publisher ? (
                <div>
                  <Text type="secondary">{publisher}</Text>
                </div>
              ) : null}
            </div>
            <Button size="small" type="primary" onClick={openCopyModal}>
              Copy
            </Button>
          </div>
        }
        description={
          description || license ? (
            <div style={{ marginTop: 4 }}>
              {description ? (
                <Paragraph style={{ marginBottom: license ? 4 : 0 }}>
                  {description}
                </Paragraph>
              ) : null}
              {license ? (
                <Text type="secondary">License: {license}</Text>
              ) : null}
            </div>
          ) : undefined
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
          {copyProgress ? (
            <Alert type="info" showIcon title={copyProgress} />
          ) : null}
          {placementMessage ? (
            <Alert type="warning" showIcon title={placementMessage} />
          ) : null}
          {copyMode === "existing" ? (
            <>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>
                  Destination project
                </div>
                <SelectProject
                  fullCollaboratorOnly
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
