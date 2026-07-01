/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Checkbox,
  InputNumber,
  Modal,
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
import { listSiteLicenseOverviews } from "@cocalc/frontend/purchases/api";
import { User } from "@cocalc/frontend/users/user";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { SiteLicenseOverview } from "@cocalc/conat/hub/api/purchases";
import type { SettingsPageDefinition } from "./settings-page";

const { Text } = Typography;
const SHARE_COLUMN_WIDTH = 420;
const PROJECT_PATH_COLUMN_WIDTH = 340;

const WRAPPING_CELL_TEXT_STYLE = {
  display: "block",
  maxWidth: "100%",
  overflowWrap: "anywhere",
  whiteSpace: "normal",
  wordBreak: "break-word",
} as const;

const PUBLIC_SHARES_NOTICE_STYLE = {
  minHeight: 88,
} as const;

const PUBLIC_SHARES_NOTICE_DESCRIPTION_STYLE = {
  alignItems: "center",
  display: "flex",
  minHeight: 32,
} as const;

type PublicSharesState = {
  error: string;
  loading: boolean;
  shares: PublicDirectoryShareSummary[];
  totalCount: number;
};

interface SiteLicensePoolOption {
  value: string;
  label: string;
  site_license_id: string;
  membership_class: string;
  available_seat_count?: number | null;
}

function canManageSiteLicense(overview: SiteLicenseOverview): boolean {
  return overview.viewer_role === "admin" || overview.viewer_role === "manager";
}

function siteLicenseName(overview: SiteLicenseOverview): string {
  return (
    overview.site_license.organization_name ||
    overview.site_license.name ||
    overview.site_license.id
  );
}

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
  const [selectedShareIds, setSelectedShareIds] = useState<string[]>([]);
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [bulkLicenseOpen, setBulkLicenseOpen] = useState(false);
  const [bulkSiteLicenseOverviews, setBulkSiteLicenseOverviews] = useState<
    SiteLicenseOverview[]
  >([]);
  const [bulkSiteLicensesLoading, setBulkSiteLicensesLoading] = useState(false);
  const [bulkSiteLicensePoolId, setBulkSiteLicensePoolId] = useState("");
  const [bulkSiteLicenseDurationDays, setBulkSiteLicenseDurationDays] =
    useState(30);
  const [bulkCopyRequiresGrant, setBulkCopyRequiresGrant] = useState(false);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    origin: "public directory shares",
  });
  const selectedShares = useMemo(() => {
    const selected = new Set(selectedShareIds);
    return state.shares.filter((share) => selected.has(share.id));
  }, [selectedShareIds, state.shares]);
  const selectedEnabledShares = useMemo(
    () => selectedShares.filter((share) => !share.disabled),
    [selectedShares],
  );
  const selectedDisabledShares = useMemo(
    () => selectedShares.filter((share) => share.disabled),
    [selectedShares],
  );
  const siteLicensePoolOptions = useMemo<SiteLicensePoolOption[]>(
    () =>
      bulkSiteLicenseOverviews.flatMap((overview) =>
        overview.pools.map((pool) => {
          const poolName = pool.pool_name || pool.membership_class;
          const seatCount =
            pool.available_seat_count == null
              ? "unknown seats"
              : `${pool.available_seat_count} available`;
          return {
            value: pool.id,
            label: `${siteLicenseName(overview)}: ${poolName} (${pool.membership_class}, ${seatCount})`,
            site_license_id: overview.site_license.id,
            membership_class: pool.membership_class,
            available_seat_count: pool.available_seat_count,
          };
        }),
      ),
    [bulkSiteLicenseOverviews],
  );

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

  async function updateSelectedShares({
    shares,
    updateForShare,
  }: {
    shares: PublicDirectoryShareSummary[];
    updateForShare: (share: PublicDirectoryShareSummary) => {
      disabled?: boolean;
      site_license_id?: string | null;
      site_license_pool_id?: string | null;
      site_license_duration_days?: number | null;
      site_license_grant_on_copy?: boolean;
      site_license_copy_requires_grant?: boolean;
    };
  }) {
    if (shares.length === 0) return;
    setBulkUpdating(true);
    setState((prev) => ({ ...prev, error: "" }));
    const failures: string[] = [];
    try {
      const completed = await runFreshAuthAction(async () => {
        for (const share of shares) {
          try {
            await webapp_client.conat_client.hub.publicDirectoryShares.update({
              id: share.id,
              ...updateForShare(share),
            });
          } catch (err) {
            failures.push(
              `${share.slug}: ${normalizeUserFacingError(err).message}`,
            );
          }
        }
      });
      if (completed) {
        await loadShares();
        if (failures.length === 0) {
          setSelectedShareIds([]);
        } else {
          setState((prev) => ({
            ...prev,
            error: `Updated ${
              shares.length - failures.length
            } of ${shares.length.toLocaleString()} selected share(s). ${
              failures.length
            } failed. First failure: ${failures[0]}`,
          }));
        }
      }
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: normalizeUserFacingError(err).message,
      }));
    } finally {
      setBulkUpdating(false);
    }
  }

  async function setSelectedDisabled(disabled: boolean) {
    await updateSelectedShares({
      shares: disabled ? selectedEnabledShares : selectedDisabledShares,
      updateForShare: () => ({ disabled }),
    });
  }

  async function applyBulkSiteLicense() {
    const selectedPool = siteLicensePoolOptions.find(
      (option) => option.value === bulkSiteLicensePoolId,
    );
    if (!selectedPool) return;
    await updateSelectedShares({
      shares: selectedShares,
      updateForShare: () => ({
        site_license_grant_on_copy: true,
        site_license_copy_requires_grant: bulkCopyRequiresGrant,
        site_license_id: selectedPool.site_license_id,
        site_license_pool_id: selectedPool.value,
        site_license_duration_days: bulkSiteLicenseDurationDays,
      }),
    });
    setBulkLicenseOpen(false);
  }

  useEffect(() => {
    void loadShares();
  }, []);

  useEffect(() => {
    const currentShareIds = new Set(state.shares.map((share) => share.id));
    setSelectedShareIds((current) =>
      current.filter((shareId) => currentShareIds.has(shareId)),
    );
  }, [state.shares]);

  useEffect(() => {
    if (!bulkLicenseOpen) return;
    let canceled = false;
    setBulkSiteLicensesLoading(true);
    listSiteLicenseOverviews()
      .then((overviews) => {
        if (canceled) return;
        const manageable = overviews.filter(canManageSiteLicense);
        setBulkSiteLicenseOverviews(manageable);
        const poolIds = new Set(
          manageable.flatMap((overview) =>
            overview.pools.map((pool) => pool.id),
          ),
        );
        setBulkSiteLicensePoolId((current) =>
          current && poolIds.has(current) ? current : "",
        );
      })
      .catch((err) => {
        if (canceled) return;
        setBulkSiteLicenseOverviews([]);
        setBulkSiteLicensePoolId("");
        setState((prev) => ({
          ...prev,
          error: normalizeUserFacingError(err).message,
        }));
      })
      .finally(() => {
        if (!canceled) setBulkSiteLicensesLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [bulkLicenseOpen]);

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
            style={PUBLIC_SHARES_NOTICE_STYLE}
            message={
              selectedShares.length > 0
                ? `${selectedShares.length.toLocaleString()} publication(s) selected`
                : "Signed-in users can view available shares."
            }
            description={
              <div style={PUBLIC_SHARES_NOTICE_DESCRIPTION_STYLE}>
                {selectedShares.length > 0 ? (
                  <Space wrap>
                    <Popconfirm
                      title={`Disable ${selectedEnabledShares.length.toLocaleString()} selected publication(s)?`}
                      description="This stops public access but keeps the publication records visible here so they can be re-enabled later."
                      okText="Disable selected"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => void setSelectedDisabled(true)}
                      disabled={selectedEnabledShares.length === 0}
                    >
                      <Button
                        danger
                        loading={bulkUpdating}
                        disabled={selectedEnabledShares.length === 0}
                      >
                        Disable selected
                      </Button>
                    </Popconfirm>
                    <Popconfirm
                      title={`Enable ${selectedDisabledShares.length.toLocaleString()} selected publication(s)?`}
                      description="This restores public access for disabled publication records. Old disabled rows without saved visibility are restored as unlisted."
                      okText="Enable selected"
                      onConfirm={() => void setSelectedDisabled(false)}
                      disabled={selectedDisabledShares.length === 0}
                    >
                      <Button
                        loading={bulkUpdating}
                        disabled={selectedDisabledShares.length === 0}
                      >
                        Enable selected
                      </Button>
                    </Popconfirm>
                    <Button
                      onClick={() => setBulkLicenseOpen(true)}
                      loading={bulkUpdating}
                    >
                      Set copy license...
                    </Button>
                    <Button onClick={() => setSelectedShareIds([])}>
                      Clear selection
                    </Button>
                  </Space>
                ) : (
                  <span>
                    Shares marked not yet available were imported from legacy
                    metadata, but the backing project files have not been
                    restored on this site yet.
                  </span>
                )}
              </div>
            }
          />

          <Space wrap>
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
              rowSelection={{
                selectedRowKeys: selectedShareIds,
                onChange: (keys) =>
                  setSelectedShareIds(keys.map((key) => `${key}`)),
              }}
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
      <Modal
        title={`Set copy license for ${selectedShares.length.toLocaleString()} selected publication(s)`}
        open={bulkLicenseOpen}
        okText="Apply to selected"
        okButtonProps={{
          disabled:
            !bulkSiteLicensePoolId ||
            selectedShares.length === 0 ||
            bulkUpdating,
        }}
        confirmLoading={bulkUpdating}
        onOk={() => void applyBulkSiteLicense()}
        onCancel={() => setBulkLicenseOpen(false)}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            message="Selected shares will offer temporary membership on copy."
            description="The existing share URLs and publication metadata are kept. Each selected share is validated server-side before it is updated."
          />
          <div>
            <Text strong>Site-license tier</Text>
            <Select
              style={{ width: "100%", marginTop: 6 }}
              loading={bulkSiteLicensesLoading}
              value={bulkSiteLicensePoolId || undefined}
              onChange={(value) => setBulkSiteLicensePoolId(value)}
              placeholder="Select a managed site-license pool"
              options={siteLicensePoolOptions.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
            />
          </div>
          {siteLicensePoolOptions.length === 0 && !bulkSiteLicensesLoading ? (
            <Alert
              type="warning"
              showIcon
              message="No managed site-license pools are available for your account."
            />
          ) : null}
          <Space>
            <Text strong>Duration</Text>
            <InputNumber
              min={1}
              max={365}
              value={bulkSiteLicenseDurationDays}
              onChange={(value) =>
                setBulkSiteLicenseDurationDays(Number(value ?? 30))
              }
            />
            <Text>days</Text>
          </Space>
          <Checkbox
            checked={bulkCopyRequiresGrant}
            onChange={(event) => setBulkCopyRequiresGrant(event.target.checked)}
          >
            Block copying if the grant fails for a reason other than the pool
            being full
          </Checkbox>
        </Space>
      </Modal>
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
