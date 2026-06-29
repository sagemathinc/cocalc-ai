/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Empty,
  Modal,
  Popconfirm,
  Popover,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { useEffect, useState } from "react";

import { alert_message } from "@cocalc/frontend/alerts";
import { useActions } from "@cocalc/frontend/app-framework";
import CopyButton from "@cocalc/frontend/components/copy-button";
import { Icon, Loading } from "@cocalc/frontend/components";
import DirectorySelector from "@cocalc/frontend/project/directory-selector";
import { normalizeUserFacingError } from "@cocalc/frontend/components/user-facing-error";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { PublicDirectoryShareSummary } from "@cocalc/conat/hub/api/public-directory-shares";

const { Text, Paragraph } = Typography;

function shareUrl(slug: string): string {
  return `${window.location.origin}/share/${slug
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function pathLabel(path: string): string {
  return path === "." ? "Project files" : path;
}

function visibilityColor(visibility: string): string | undefined {
  switch (visibility) {
    case "listed":
      return "green";
    case "unlisted":
      return "blue";
    case "private":
      return "default";
    case "disabled":
      return "red";
  }
}

export function PublishPanel({
  project_id,
}: {
  project_id: string;
}): React.JSX.Element {
  const actions = useActions({ project_id });
  const [shares, setShares] = useState<PublicDirectoryShareSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);

  async function loadShares(): Promise<void> {
    setLoading(true);
    setError("");
    try {
      const result =
        await webapp_client.conat_client.hub.publicDirectoryShares.listProject({
          project_id,
          include_disabled: false,
          limit: 1000,
        });
      setShares(result.shares);
    } catch (err) {
      setError(normalizeUserFacingError(err).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadShares();
  }, [project_id]);

  async function openPublishModal(path: string): Promise<void> {
    if (actions == null) return;
    await actions.showFileActionPanel({
      path,
      action: "publish",
    });
  }

  async function disableShare(
    share: PublicDirectoryShareSummary,
  ): Promise<void> {
    setError("");
    try {
      await webapp_client.conat_client.hub.publicDirectoryShares.update({
        id: share.id,
        disabled: true,
      });
      alert_message({
        type: "success",
        message: "Publication disabled.",
      });
      await loadShares();
    } catch (err) {
      setError(normalizeUserFacingError(err).message);
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Space align="center" style={{ justifyContent: "space-between" }}>
        <Text strong>Publish read-only project content</Text>
        <Popover
          title="About public project shares"
          content={
            <Paragraph style={{ maxWidth: 340, marginBottom: 0 }}>
              Published directories are unlisted and visible to signed-in CoCalc
              users who know the URL. Publishing the entire project means{" "}
              <code>/home/user</code>; private internals such as{" "}
              <code>.ssh</code>, <code>.cache</code>, <code>.local</code>, and{" "}
              <code>.snapshots</code> are excluded. Your membership tier limits
              how many active directories you can publish.
            </Paragraph>
          }
        >
          <Button
            size="small"
            shape="circle"
            icon={<Icon name="question-circle" />}
          />
        </Popover>
      </Space>

      <Space wrap>
        <Button
          type="primary"
          icon={<Icon name="link" />}
          onClick={() => void openPublishModal("/home/user")}
        >
          Publish entire project
        </Button>
        <Button onClick={() => setFolderPickerOpen(true)}>
          Publish folder...
        </Button>
        <Button onClick={() => void loadShares()} loading={loading}>
          Refresh
        </Button>
      </Space>

      {error ? <Alert type="error" showIcon message={error} /> : null}

      {loading && shares.length === 0 ? (
        <Loading />
      ) : shares.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No project directories are published."
        />
      ) : (
        <Table<PublicDirectoryShareSummary>
          rowKey="id"
          dataSource={shares}
          pagination={false}
          size="small"
        >
          <Table.Column<PublicDirectoryShareSummary>
            title="Published paths"
            render={(_, share) => {
              const url = shareUrl(share.slug);
              const editPath = share.path === "." ? "/home/user" : share.path;
              return (
                <Space direction="vertical" size={6} style={{ width: "100%" }}>
                  <div>
                    <Text strong>{pathLabel(share.path)}</Text>{" "}
                    <Text code>
                      {share.path === "." ? "/home/user" : share.path}
                    </Text>
                  </div>
                  <Space wrap size={[4, 4]}>
                    <Tag color={visibilityColor(share.visibility)}>
                      {share.visibility}
                    </Tag>
                    {share.site_license_grant_on_copy ? (
                      <Tag color="blue">membership on copy</Tag>
                    ) : null}
                    {share.title ? <Tag>{share.title}</Tag> : null}
                  </Space>
                  <Space wrap size={[6, 6]}>
                    <a href={url} target="_blank" rel="noreferrer">
                      /share/{share.slug}
                    </a>
                    <CopyButton value={url} size="small" />
                  </Space>
                  <Space wrap size={[6, 6]}>
                    <Button
                      size="small"
                      onClick={() => void openPublishModal(editPath)}
                    >
                      Edit
                    </Button>
                    <Button size="small" href={url} target="_blank">
                      View
                    </Button>
                    <Popconfirm
                      title="Disable this publication?"
                      description="The URL will stop granting viewer access. People who already copied files keep their copies."
                      okText="Disable"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => void disableShare(share)}
                    >
                      <Button size="small" danger>
                        Disable
                      </Button>
                    </Popconfirm>
                  </Space>
                </Space>
              );
            }}
          />
        </Table>
      )}

      <Modal
        title="Choose a folder to publish"
        open={folderPickerOpen}
        footer={null}
        onCancel={() => setFolderPickerOpen(false)}
        destroyOnHidden
      >
        <DirectorySelector
          project_id={project_id}
          title="Select a folder in this project"
          style={{ width: "100%" }}
          bodyStyle={{ maxHeight: "55vh" }}
          onSelect={(path) => {
            setFolderPickerOpen(false);
            void openPublishModal(path || "/home/user");
          }}
        />
      </Modal>
    </Space>
  );
}
