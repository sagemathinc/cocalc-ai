/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Card, Space, Table, Tag, Typography } from "antd";
import { useEffect, useState } from "react";
import { defineMessage } from "react-intl";

import type { PublicDirectoryShareSummary } from "@cocalc/conat/hub/api/public-directory-shares";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Loading, Tooltip } from "@cocalc/frontend/components";
import CopyButton from "@cocalc/frontend/components/copy-button";
import { normalizeUserFacingError } from "@cocalc/frontend/components/user-facing-error";
import { ProjectTitle } from "@cocalc/frontend/projects/project-title";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { SettingsPageDefinition } from "./settings-page";

const { Text } = Typography;

type PublicSharesState = {
  error: string;
  loading: boolean;
  shares: PublicDirectoryShareSummary[];
  totalCount: number;
};

function shareHref(slug: string): string {
  return `/share/${slug.split("/").map(encodeURIComponent).join("/")}`;
}

function absoluteShareUrl(slug: string): string {
  const href = shareHref(slug);
  if (typeof window == "undefined") return href;
  return new URL(href, window.location.href).href;
}

function availabilityTag(share: PublicDirectoryShareSummary) {
  if (share.disabled) return <Tag>Disabled</Tag>;
  switch (share.availability_status) {
    case "available":
      return <Tag color="green">Available</Tag>;
    case "pending":
      return <Tag color="gold">Pending restore</Tag>;
    case "unavailable":
      return <Tag>Not yet available</Tag>;
    default:
      return <Tag>Unknown</Tag>;
  }
}

function exceptionalVisibilityTag(share: PublicDirectoryShareSummary) {
  if (share.disabled || share.visibility == "unlisted") return null;
  switch (share.visibility) {
    case "listed":
      return <Tag color="blue">Listed</Tag>;
    case "private":
      return <Tag color="gold">Private</Tag>;
    case "disabled":
      return null;
  }
}

function projectPathHref(share: PublicDirectoryShareSummary): string {
  const parts =
    share.path == "."
      ? []
      : share.path.split("/").filter((part) => part.length > 0);
  const encodedPath = parts.map(encodeURIComponent).join("/");
  return `/projects/${share.project_id}/files/${encodedPath}`;
}

function projectPathLabel(path: string): string {
  return path == "." ? "/home/user" : path;
}

function PublicSharesPage() {
  const publicDirectorySharesEnabled = !!useTypedRedux(
    "customize",
    "public_directory_shares_enabled",
  );
  const projectMap = useTypedRedux("projects", "project_map");
  const [state, setState] = useState<PublicSharesState>({
    error: "",
    loading: false,
    shares: [],
    totalCount: 0,
  });

  async function loadShares() {
    setState((prev) => ({ ...prev, error: "", loading: true }));
    try {
      const result =
        await webapp_client.conat_client.hub.publicDirectoryShares.listMine({
          include_disabled: true,
          limit: 5000,
        });
      setState({
        error: "",
        loading: false,
        shares: result.shares,
        totalCount: result.total_count,
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: normalizeUserFacingError(err).message,
        loading: false,
      }));
    }
  }

  useEffect(() => {
    if (!publicDirectorySharesEnabled) return;
    void loadShares();
  }, [publicDirectorySharesEnabled]);

  if (!publicDirectorySharesEnabled) {
    return (
      <Alert
        type="warning"
        showIcon
        message="Public directory shares are not enabled on this site."
      />
    );
  }

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card>
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <div>
            <Text type="secondary">
              These are public or unlisted directory shares owned by projects
              you can administer. Migrated cocalc.com shares appear here after
              import.
            </Text>
          </div>

          <Alert
            type="info"
            showIcon
            message="Signed-in users can view available shares."
            description="Shares marked not yet available were imported from legacy metadata, but the backing project files have not been restored on this site yet."
          />

          <Space>
            <Button onClick={() => void loadShares()} loading={state.loading}>
              Refresh
            </Button>
            <Text type="secondary">
              Showing {state.shares.length.toLocaleString()} of{" "}
              {state.totalCount.toLocaleString()} shares.
            </Text>
          </Space>

          {state.error ? (
            <Alert type="error" showIcon message={state.error} />
          ) : null}

          {state.loading && state.shares.length === 0 ? (
            <Loading />
          ) : (
            <Table<PublicDirectoryShareSummary>
              rowKey="id"
              dataSource={state.shares}
              pagination={{ defaultPageSize: 25, showSizeChanger: true }}
              columns={[
                {
                  title: "Share",
                  dataIndex: "slug",
                  render: (_value, share) => {
                    const href = shareHref(share.slug);
                    return (
                      <Space direction="vertical" size={0}>
                        <Space size={6}>
                          <a href={href} target="_blank" rel="noreferrer">
                            {share.title || share.slug}
                          </a>
                          <CopyButton
                            value={absoluteShareUrl(share.slug)}
                            size="small"
                            noText
                          />
                          {share.legacy_url ? (
                            <Tooltip title={share.legacy_url}>
                              <Tag>Migrated</Tag>
                            </Tooltip>
                          ) : null}
                        </Space>
                        {share.title ? (
                          <Text type="secondary">{share.slug}</Text>
                        ) : null}
                        {share.description ? (
                          <Text type="secondary" ellipsis>
                            {share.description}
                          </Text>
                        ) : null}
                      </Space>
                    );
                  },
                },
                {
                  title: "Status",
                  width: 190,
                  render: (_value, share) => (
                    <Space direction="vertical" size={4}>
                      {availabilityTag(share)}
                      {exceptionalVisibilityTag(share)}
                      {share.site_license_grant_on_copy ? (
                        <Tag color="blue">
                          License on copy
                          {share.site_license_membership_tier_id
                            ? `: ${share.site_license_membership_tier_id}`
                            : ""}
                          {share.site_license_duration_days
                            ? ` / ${share.site_license_duration_days}d`
                            : ""}
                        </Tag>
                      ) : null}
                    </Space>
                  ),
                },
                {
                  title: "Project path",
                  render: (_value, share) => {
                    const archived =
                      projectMap?.getIn?.([
                        share.project_id,
                        "state",
                        "state",
                      ]) == "archived";
                    return (
                      <Space direction="vertical" size={2}>
                        <a href={projectPathHref(share)}>
                          <ProjectTitle
                            project_id={share.project_id}
                            trunc={42}
                            noClick
                          />
                        </a>
                        <Text code>{projectPathLabel(share.path)}</Text>
                        {archived ? (
                          <Tag color="orange">
                            Archived project: dearchive to access
                          </Tag>
                        ) : null}
                      </Space>
                    );
                  },
                },
              ]}
            />
          )}
        </Space>
      </Card>
    </Space>
  );
}

export const PUBLIC_SHARES_SETTINGS_PAGE = {
  component: PublicSharesPage,
  description: defineMessage({
    id: "account.settings.public-shares.description",
    defaultMessage: "Manage public directory shares owned by your projects.",
  }),
  icon: "share-square",
  key: "public-shares",
  label: defineMessage({
    id: "account.settings.public-shares.label",
    defaultMessage: "Public shares",
  }),
  title: defineMessage({
    id: "account.settings.public-shares.title",
    defaultMessage: "Public Directory Shares",
  }),
} satisfies SettingsPageDefinition;
