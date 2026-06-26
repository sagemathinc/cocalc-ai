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
  Table,
  Tag,
  Typography,
} from "antd";
import { useEffect, useState } from "react";

import type {
  PublicDirectoryShareDirectoryEntry,
  ResolvedPublicDirectoryShare,
} from "@cocalc/conat/hub/api/public-directory-shares";
import { appUrl } from "@cocalc/frontend/auth/util";
import { Icon } from "@cocalc/frontend/components/icon";
import { normalizeUserFacingError } from "@cocalc/frontend/components/user-facing-error";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import { SelectProject } from "@cocalc/frontend/projects/select-project";

const { Text } = Typography;

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

function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  if (value < 1024) return `${Math.round(value).toLocaleString()} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && scaled >= 1024; i += 1) {
    scaled /= 1024;
    unit = units[i];
  }
  return `${scaled.toFixed(scaled < 10 ? 1 : 0)} ${unit}`;
}

function formatMtime(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  return new Date(value).toLocaleString();
}

function parentPath(path: string): string {
  if (path === ".") return ".";
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.length === 0 ? "." : parts.join("/");
}

function isDirectory(entry: PublicDirectoryShareDirectoryEntry): boolean {
  return entry.type === "d" || entry.isDir === true;
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
  const [directoryPath, setDirectoryPath] = useState(".");
  const [directoryEntries, setDirectoryEntries] = useState<
    PublicDirectoryShareDirectoryEntry[]
  >([]);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState("");
  const [directoryReload, setDirectoryReload] = useState(0);
  const normalizedSlug = `${slug ?? ""}`.trim();

  useEffect(() => {
    setDirectoryPath(".");
  }, [normalizedSlug]);

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

  useEffect(() => {
    if (!isLoggedIn || !share?.available) {
      setDirectoryEntries([]);
      setDirectoryError("");
      return;
    }
    let canceled = false;
    setDirectoryLoading(true);
    setDirectoryError("");
    webapp_client.conat_client.hub.publicDirectoryShares
      .listDirectory({ slug: share.slug, path: directoryPath })
      .then((result) => {
        if (canceled) return;
        setDirectoryEntries(result.entries);
      })
      .catch((err) => {
        if (canceled) return;
        setDirectoryEntries([]);
        setDirectoryError(normalizeUserFacingError(err).message);
      })
      .finally(() => {
        if (!canceled) setDirectoryLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [
    directoryPath,
    directoryReload,
    isLoggedIn,
    share?.available,
    share?.slug,
  ]);

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
              <Card size="small" title="Shared files">
                <Space direction="vertical" style={{ width: "100%" }}>
                  <Space>
                    <Button
                      disabled={directoryPath === "."}
                      onClick={() =>
                        setDirectoryPath(parentPath(directoryPath))
                      }
                    >
                      Up
                    </Button>
                    <Button
                      onClick={() => setDirectoryReload((value) => value + 1)}
                      loading={directoryLoading}
                    >
                      Refresh
                    </Button>
                    <Text type="secondary">
                      {directoryPath === "." ? "Share root" : directoryPath}
                    </Text>
                  </Space>
                  {directoryError ? (
                    <Alert type="error" showIcon message={directoryError} />
                  ) : null}
                  <Table<PublicDirectoryShareDirectoryEntry>
                    size="small"
                    rowKey="path"
                    dataSource={directoryEntries}
                    loading={directoryLoading}
                    pagination={{
                      defaultPageSize: 50,
                      showSizeChanger: true,
                    }}
                    columns={[
                      {
                        title: "Name",
                        dataIndex: "name",
                        render: (_value, entry) => {
                          const directory = isDirectory(entry);
                          return (
                            <Space>
                              <Icon name={directory ? "folder" : "file"} />
                              {directory ? (
                                <Button
                                  type="link"
                                  style={{ padding: 0 }}
                                  onClick={() => setDirectoryPath(entry.path)}
                                >
                                  {entry.name}
                                </Button>
                              ) : (
                                <Text>{entry.name}</Text>
                              )}
                              {entry.isSymLink ? <Tag>symlink</Tag> : null}
                            </Space>
                          );
                        },
                      },
                      {
                        title: "Size",
                        dataIndex: "size",
                        width: 120,
                        render: (value) => formatBytes(value),
                      },
                      {
                        title: "Modified",
                        dataIndex: "mtime",
                        width: 220,
                        render: (value) => formatMtime(value),
                      },
                    ]}
                  />
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

            {share.available ? (
              <Card size="small" title="Copy to one of your projects">
                <Space direction="vertical" style={{ width: "100%" }}>
                  <Alert
                    type="info"
                    showIcon
                    message="Copy this directory when you want to work with it."
                    description="The shared directory itself is read-only. Copying creates your own editable copy in a project you can access."
                  />
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
            ) : null}

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
