/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import { defineMessage } from "react-intl";

import type { PublicDirectoryShareSummary } from "@cocalc/conat/hub/api/public-directory-shares";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { Loading, Tooltip } from "@cocalc/frontend/components";
import CopyButton from "@cocalc/frontend/components/copy-button";
import { normalizeUserFacingError } from "@cocalc/frontend/components/user-facing-error";
import { load_target } from "@cocalc/frontend/history";
import { ProjectTitle } from "@cocalc/frontend/projects/project-title";
import { User } from "@cocalc/frontend/users/user";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { SettingsPageDefinition } from "./settings-page";

const { Text } = Typography;
const BULK_UNPUBLISH_CONFIRMATION = "UNPUBLISH";
const SHARE_COLUMN_WIDTH = 420;
const PROJECT_PATH_COLUMN_WIDTH = 340;

const WRAPPING_CELL_TEXT_STYLE = {
  display: "block",
  maxWidth: "100%",
  overflowWrap: "anywhere",
  whiteSpace: "normal",
  wordBreak: "break-word",
} as const;

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
      return <Text type="secondary">-</Text>;
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
  const parts = [
    "home",
    "user",
    ...(share.path == "."
      ? []
      : share.path.split("/").filter((part) => part.length > 0)),
  ];
  const encodedPath = parts.map(encodeURIComponent).join("/");
  return `/projects/${share.project_id}/files/${encodedPath}/`;
}

function projectPathTarget(share: PublicDirectoryShareSummary): string {
  return projectPathHref(share).replace(/^\/+/, "");
}

function projectPathLabel(path: string): string {
  return path == "." ? "/home/user" : path;
}

function PublicSharesPage() {
  const projectMap = useTypedRedux("projects", "project_map");
  const [state, setState] = useState<PublicSharesState>({
    error: "",
    loading: false,
    shares: [],
    totalCount: 0,
  });
  const [bulkActorAccountId, setBulkActorAccountId] = useState<
    string | undefined
  >();
  const [bulkDisabling, setBulkDisabling] = useState(false);
  const [bulkConfirmText, setBulkConfirmText] = useState("");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    origin: "public directory shares",
  });
  const actorAccountIds = useMemo(() => {
    const ids = new Set<string>();
    for (const share of state.shares) {
      if (share.created_by) ids.add(share.created_by);
      if (share.updated_by) ids.add(share.updated_by);
    }
    return Array.from(ids).sort();
  }, [state.shares]);
  const selectedActorDisableCount = useMemo(() => {
    if (!bulkActorAccountId) return 0;
    return state.shares.filter(
      (share) =>
        !share.disabled &&
        (share.created_by === bulkActorAccountId ||
          share.updated_by === bulkActorAccountId),
    ).length;
  }, [bulkActorAccountId, state.shares]);

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

  async function disableSharesByActor() {
    if (!bulkActorAccountId) return;
    setBulkDisabling(true);
    setState((prev) => ({ ...prev, error: "" }));
    try {
      const completed = await runFreshAuthAction(async () => {
        await webapp_client.conat_client.hub.publicDirectoryShares.disableMineByActor(
          {
            actor_account_id: bulkActorAccountId,
          },
        );
      });
      if (completed) {
        await loadShares();
      }
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: normalizeUserFacingError(err).message,
      }));
    } finally {
      setBulkDisabling(false);
    }
  }

  useEffect(() => {
    void loadShares();
  }, []);

  useEffect(() => {
    if (!bulkActorAccountId) return;
    if (!actorAccountIds.includes(bulkActorAccountId)) {
      setBulkActorAccountId(undefined);
    }
  }, [actorAccountIds, bulkActorAccountId]);

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

          <Space wrap>
            <Button onClick={() => void loadShares()} loading={state.loading}>
              Refresh
            </Button>
            <Select
              allowClear
              placeholder="User to unpublish"
              style={{ minWidth: 240 }}
              value={bulkActorAccountId}
              onChange={setBulkActorAccountId}
              options={actorAccountIds.map((actorAccountId) => ({
                value: actorAccountId,
                label: (
                  <User
                    account_id={actorAccountId}
                    trunc={28}
                    show_avatar
                    avatarSize={18}
                  />
                ),
              }))}
            />
            <Popconfirm
              title="Unpublish all shares for this user?"
              description={
                bulkActorAccountId ? (
                  <Space direction="vertical" size={8}>
                    <Text>
                      This disables {selectedActorDisableCount.toLocaleString()}{" "}
                      active share(s) whose creator or last updater is the
                      selected user. Existing copied files remain copied.
                    </Text>
                    <Text>
                      Type <Text code>{BULK_UNPUBLISH_CONFIRMATION}</Text> to
                      confirm.
                    </Text>
                    <Input
                      value={bulkConfirmText}
                      onChange={(event) =>
                        setBulkConfirmText(event.target.value)
                      }
                      placeholder={BULK_UNPUBLISH_CONFIRMATION}
                    />
                  </Space>
                ) : (
                  "Select a user first."
                )
              }
              okText="Unpublish all"
              okButtonProps={{
                danger: true,
                disabled: bulkConfirmText !== BULK_UNPUBLISH_CONFIRMATION,
              }}
              onConfirm={() => void disableSharesByActor()}
              onOpenChange={(open) => {
                if (open) setBulkConfirmText("");
              }}
              disabled={!bulkActorAccountId || selectedActorDisableCount === 0}
            >
              <Button
                danger
                loading={bulkDisabling}
                disabled={
                  !bulkActorAccountId || selectedActorDisableCount === 0
                }
              >
                Unpublish All
              </Button>
            </Popconfirm>
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
              scroll={{ x: 1140 }}
              tableLayout="fixed"
              columns={[
                {
                  title: "Share",
                  dataIndex: "slug",
                  width: SHARE_COLUMN_WIDTH,
                  render: (_value, share) => {
                    const href = shareHref(share.slug);
                    return (
                      <Space
                        direction="vertical"
                        size={0}
                        style={{ maxWidth: SHARE_COLUMN_WIDTH, width: "100%" }}
                      >
                        <div
                          style={{
                            alignItems: "flex-start",
                            display: "flex",
                            gap: 6,
                            minWidth: 0,
                          }}
                        >
                          <a
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            style={{
                              ...WRAPPING_CELL_TEXT_STYLE,
                              flex: "1 1 auto",
                              minWidth: 0,
                            }}
                          >
                            {share.title || share.slug}
                          </a>
                          <CopyButton
                            value={absoluteShareUrl(share.slug)}
                            size="small"
                            noText
                          />
                          {share.legacy_url ? (
                            <Tooltip title={share.legacy_url}>
                              <Tag style={{ marginInlineEnd: 0 }}>Migrated</Tag>
                            </Tooltip>
                          ) : null}
                        </div>
                        {share.title ? (
                          <Text
                            type="secondary"
                            style={WRAPPING_CELL_TEXT_STYLE}
                          >
                            {share.slug}
                          </Text>
                        ) : null}
                        {share.description ? (
                          <Text
                            type="secondary"
                            ellipsis
                            style={WRAPPING_CELL_TEXT_STYLE}
                          >
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
                  title: "Updated by",
                  width: 180,
                  render: (_value, share) => {
                    const updatedBy = share.updated_by ?? share.created_by;
                    return (
                      <Space direction="vertical" size={0}>
                        {updatedBy ? (
                          <User
                            account_id={updatedBy}
                            trunc={24}
                            show_avatar
                            avatarSize={18}
                          />
                        ) : (
                          <Text type="secondary">-</Text>
                        )}
                        {share.created_by && share.created_by !== updatedBy ? (
                          <Text type="secondary">
                            Created by{" "}
                            <User account_id={share.created_by} trunc={18} />
                          </Text>
                        ) : null}
                      </Space>
                    );
                  },
                },
                {
                  title: "Project path",
                  width: PROJECT_PATH_COLUMN_WIDTH,
                  render: (_value, share) => {
                    const archived =
                      projectMap?.getIn?.([
                        share.project_id,
                        "state",
                        "state",
                      ]) == "archived";
                    return (
                      <Space direction="vertical" size={2}>
                        <a
                          href={projectPathHref(share)}
                          onClick={(event) => {
                            if (
                              event.metaKey ||
                              event.ctrlKey ||
                              event.shiftKey ||
                              event.altKey ||
                              event.button !== 0
                            ) {
                              return;
                            }
                            event.preventDefault();
                            load_target(projectPathTarget(share));
                          }}
                        >
                          <ProjectTitle
                            project_id={share.project_id}
                            trunc={42}
                            noClick
                          />
                        </a>
                        <Text code style={WRAPPING_CELL_TEXT_STYLE}>
                          {projectPathLabel(share.path)}
                        </Text>
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
      <FreshAuthModal {...freshAuthModalProps} />
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
