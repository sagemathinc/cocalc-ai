/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Descriptions,
  Input,
  Result,
  Skeleton,
  Space,
  Tag,
} from "antd";
import { useEffect, useState } from "react";

import type { ResolvedPublicDirectoryShare } from "@cocalc/conat/hub/api/public-directory-shares";
import { appUrl } from "@cocalc/frontend/auth/util";
import { Icon } from "@cocalc/frontend/components/icon";
import { normalizeUserFacingError } from "@cocalc/frontend/components/user-facing-error";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";

function authHref(view: "sign-in" | "sign-up"): string {
  const target = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return `${appUrl(`auth/${view}`)}?target=${encodeURIComponent(target)}`;
}

function availabilityColor(status?: string): string {
  switch (status) {
    case "available":
      return "green";
    case "pending":
      return "gold";
    case "unavailable":
      return "red";
    default:
      return "default";
  }
}

export function PublicDirectorySharePage({ slug }: { slug?: string }) {
  const isLoggedIn = !!useTypedRedux("account", "is_logged_in");
  const projectActions = useActions("projects");
  const [loading, setLoading] = useState(false);
  const [share, setShare] = useState<ResolvedPublicDirectoryShare | null>(null);
  const [error, setError] = useState<string>("");
  const [destinationProjectId, setDestinationProjectId] = useState("");
  const [destinationPath, setDestinationPath] = useState(".");
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const normalizedSlug = `${slug ?? ""}`.trim();

  useEffect(() => {
    if (!isLoggedIn || !normalizedSlug) {
      return;
    }
    let canceled = false;
    setLoading(true);
    setError("");
    setShare(null);
    webapp_client.conat_client.hub.publicDirectoryShares
      .resolve({ slug: normalizedSlug })
      .then((result) => {
        if (!canceled) setShare(result);
      })
      .catch((err) => {
        if (!canceled) setError(normalizeUserFacingError(err).message);
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [isLoggedIn, normalizedSlug]);

  if (!normalizedSlug) {
    return (
      <Result
        status="warning"
        title="Missing share path"
        subTitle="Open a complete shared directory link."
      />
    );
  }

  if (!isLoggedIn) {
    return (
      <div style={{ maxWidth: 760, margin: "48px auto", padding: "0 24px" }}>
        <Card>
          <Result
            icon={<Icon name="users" />}
            title="Sign in to view this shared directory"
            subTitle="CoCalc shared directories are visible to signed-in users. Reading files counts against your account egress quota."
            extra={
              <Space>
                <Button type="primary" href={authHref("sign-in")}>
                  Sign in
                </Button>
                <Button href={authHref("sign-up")}>Create account</Button>
              </Space>
            }
          />
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ maxWidth: 960, margin: "32px auto", padding: "0 24px" }}>
        <Card>
          <Skeleton active paragraph={{ rows: 5 }} />
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <Result
        status="warning"
        title="Shared directory unavailable"
        subTitle={error}
      />
    );
  }

  if (!share) {
    return null;
  }

  async function copyToProject() {
    if (!share || !destinationProjectId.trim()) return;
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
      setCopyMessage(`Copy queued as operation ${result.op_id}.`);
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
    <div style={{ maxWidth: 960, margin: "32px auto", padding: "0 24px" }}>
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        <Card>
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <div>
              <h2 style={{ marginBottom: 8 }}>{share.title || share.slug}</h2>
              {share.description ? <p>{share.description}</p> : null}
              <Space wrap>
                <Tag color={availabilityColor(share.availability_status)}>
                  {share.availability_status}
                </Tag>
                <Tag>{share.visibility}</Tag>
                {share.site_license_grant_on_copy ? (
                  <Tag color="blue">temporary access on copy</Tag>
                ) : null}
              </Space>
            </div>

            {share.available ? (
              <Card size="small" title="Copy to one of your projects">
                <Space direction="vertical" style={{ width: "100%" }}>
                  <Alert
                    type="info"
                    showIcon
                    message="Read-only browser view is still being wired"
                    description="Copying this shared directory to an existing project is available now. The inline read-only file browser is the next implementation step."
                  />
                  <Input
                    placeholder="Destination project id"
                    value={destinationProjectId}
                    onChange={(e) => setDestinationProjectId(e.target.value)}
                  />
                  <Input
                    placeholder="Destination path"
                    value={destinationPath}
                    onChange={(e) => setDestinationPath(e.target.value)}
                  />
                  <Button
                    type="primary"
                    loading={copying}
                    disabled={!destinationProjectId.trim()}
                    onClick={() => void copyToProject()}
                  >
                    Copy shared directory
                  </Button>
                  {copyMessage ? (
                    <Alert type="success" showIcon message={copyMessage} />
                  ) : null}
                  {copyError ? (
                    <Alert type="error" showIcon message={copyError} />
                  ) : null}
                </Space>
              </Card>
            ) : (
              <Alert
                type="warning"
                showIcon
                message="Files are not available yet"
                description={
                  share.availability_message ||
                  "This share was imported from the legacy share server, but the backing project files are not available on this site yet."
                }
              />
            )}

            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="Slug">{share.slug}</Descriptions.Item>
              <Descriptions.Item label="Project">
                <code>{share.project_id}</code>
              </Descriptions.Item>
              <Descriptions.Item label="Path">
                <code>{share.path}</code>
              </Descriptions.Item>
              {share.legacy_url ? (
                <Descriptions.Item label="Legacy URL">
                  {share.legacy_url}
                </Descriptions.Item>
              ) : null}
              {share.license ? (
                <Descriptions.Item label="License">
                  {share.license}
                </Descriptions.Item>
              ) : null}
            </Descriptions>
          </Space>
        </Card>
      </Space>
    </div>
  );
}
