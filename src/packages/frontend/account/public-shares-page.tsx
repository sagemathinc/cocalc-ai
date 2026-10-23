/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { cloneElement, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { defineMessage } from "react-intl";

import type { PublicDirectoryShareSummary } from "@cocalc/conat/hub/api/public-directory-shares";
import type { LegacyMigrationPublicShareSummary } from "@cocalc/conat/hub/api/legacy-migration";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  FreshAuthModal,
  isFreshAuthRequiredError,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { Loading, TimeAgo, Tooltip } from "@cocalc/frontend/components";
import CopyButton from "@cocalc/frontend/components/copy-button";
import { normalizeUserFacingError } from "@cocalc/frontend/components/user-facing-error";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown-public";
import { load_target } from "@cocalc/frontend/history";
import { ProjectTitle } from "@cocalc/frontend/projects/project-title";
import { listSiteLicenseOverviews } from "@cocalc/frontend/purchases/api";
import { User } from "@cocalc/frontend/users/user";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { SiteLicenseOverview } from "@cocalc/conat/hub/api/purchases";
import { MAX_PUBLIC_SHARE_READER_INSTRUCTIONS_LENGTH } from "@cocalc/util/public-directory-share-labels";
import { legacyMigrationProjectHref } from "./legacy-migration-link";
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

type LegacyPublicSharesState = {
  error: string;
  hasInventory: boolean;
  loading: boolean;
  page: number;
  pageSize: number;
  query: string;
  shares: LegacyMigrationPublicShareSummary[];
  totalCount: number;
};

type PublisherProfileState = {
  error: string;
  instructions: string;
  loading: boolean;
  saved: boolean;
  saving: boolean;
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
      return <Tag>Unavailable</Tag>;
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
  const suffix = share.path_type == "directory" ? "/" : "";
  return `/projects/${share.project_id}/files/${encodedPath}${suffix}`;
}

function projectPathTarget(share: PublicDirectoryShareSummary): string {
  return projectPathHref(share).replace(/^\/+/, "");
}

function projectPathLabel(path: string): string {
  return path == "." ? "/home/user" : path;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function shareDisplaySortText(share: PublicDirectoryShareSummary): string {
  return `${share.title || share.slug}\n${share.slug}`;
}

function shareStatusSortText(share: PublicDirectoryShareSummary): string {
  return [
    share.disabled ? "disabled" : share.availability_status,
    share.visibility,
    share.site_license_grant_on_copy ? "license-on-copy" : "",
    share.site_license_membership_tier_id ?? "",
  ].join("\n");
}

function shareActorSortText(share: PublicDirectoryShareSummary): string {
  return share.updated_by ?? share.created_by ?? "";
}

function shareProjectPathSortText(share: PublicDirectoryShareSummary): string {
  return `${share.project_id}\n${projectPathLabel(share.path)}`;
}

function shareMetadataUpdatedDate(
  share: PublicDirectoryShareSummary,
): Date | null {
  const value = share.updated_at ?? share.created_at ?? null;
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.valueOf()) ? date : null;
}

function shareMetadataUpdatedTimestamp(
  share: PublicDirectoryShareSummary,
): number {
  return shareMetadataUpdatedDate(share)?.valueOf() ?? 0;
}

function legacyShareDate(
  share: LegacyMigrationPublicShareSummary,
): Date | null {
  const value = share.last_edited ?? share.created ?? null;
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.valueOf()) ? date : null;
}

function legacyShareTimestamp(
  share: LegacyMigrationPublicShareSummary,
): number {
  return legacyShareDate(share)?.valueOf() ?? 0;
}

function legacyShareStatusTag({
  currentShare,
  legacyShare,
}: {
  currentShare?: PublicDirectoryShareSummary;
  legacyShare: LegacyMigrationPublicShareSummary;
}) {
  if (currentShare != null) {
    if (
      legacyShare.restore_status === "restored" &&
      currentShare.availability_status === "pending"
    ) {
      return <Tag color="gold">Restored; verification pending</Tag>;
    }
    return availabilityTag(currentShare);
  }
  if (legacyShare.import_status === "failed") {
    return <Tag color="red">Project import failed</Tag>;
  }
  if (legacyShare.import_status === "creating") {
    return <Tag color="gold">Preparing project</Tag>;
  }
  if (legacyShare.import_status === "not-imported") {
    return <Tag>Project not restored</Tag>;
  }
  if (legacyShare.restore_status === "restored") {
    return <Tag color="gold">Restored; publication replay pending</Tag>;
  }
  if (legacyShare.restore_status === "failed") {
    return <Tag color="red">Project restore failed</Tag>;
  }
  return <Tag color="gold">Project restore pending</Tag>;
}

export function PublicSharePublisherProfileCard() {
  const [profile, setProfile] = useState<PublisherProfileState>({
    error: "",
    instructions: "",
    loading: false,
    saved: false,
    saving: false,
  });

  async function loadProfile() {
    setProfile((prev) => ({
      ...prev,
      error: "",
      loading: true,
      saved: false,
    }));
    try {
      const result =
        await webapp_client.conat_client.hub.publicDirectoryShares.getPublisherProfile(
          {},
        );
      setProfile({
        error: "",
        instructions: result.reader_instructions_markdown ?? "",
        loading: false,
        saved: false,
        saving: false,
      });
    } catch (err) {
      setProfile((prev) => ({
        ...prev,
        error: normalizeUserFacingError(err).message,
        loading: false,
      }));
    }
  }

  async function saveProfile() {
    setProfile((prev) => ({
      ...prev,
      error: "",
      saved: false,
      saving: true,
    }));
    try {
      const result =
        await webapp_client.conat_client.hub.publicDirectoryShares.updatePublisherProfile(
          {
            reader_instructions_markdown: profile.instructions,
          },
        );
      setProfile((prev) => ({
        ...prev,
        instructions: result.reader_instructions_markdown ?? "",
        saved: true,
        saving: false,
      }));
    } catch (err) {
      setProfile((prev) => ({
        ...prev,
        error: normalizeUserFacingError(err).message,
        saving: false,
      }));
    }
  }

  useEffect(() => {
    void loadProfile();
  }, []);

  return (
    <Card title="Reader instructions for all your public shares">
      <Space vertical size="middle" style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          title="One update applies to every publication from your account"
          description="Use this for reusable workflow instructions. Keep article titles, abstracts, citations, and other publication-specific metadata in each share's description. An individual share can override these instructions when necessary."
        />
        <label htmlFor="public-share-reader-instructions">
          <Text strong>Instructions shown beside Copy</Text>
        </label>
        <Input.TextArea
          id="public-share-reader-instructions"
          aria-describedby="public-share-reader-instructions-help"
          value={profile.instructions}
          disabled={profile.loading}
          maxLength={MAX_PUBLIC_SHARE_READER_INSTRUCTIONS_LENGTH}
          autoSize={{ minRows: 6, maxRows: 18 }}
          placeholder="Explain how readers should copy and use your publications. Markdown is supported."
          onChange={(event) =>
            setProfile((prev) => ({
              ...prev,
              instructions: event.target.value,
              saved: false,
            }))
          }
        />
        <Text id="public-share-reader-instructions-help" type="secondary">
          Markdown supported. Clearing this field removes the account-wide
          instructions. {profile.instructions.length.toLocaleString()}/
          {MAX_PUBLIC_SHARE_READER_INSTRUCTIONS_LENGTH.toLocaleString()}
        </Text>
        <Space wrap>
          <Button
            type="primary"
            loading={profile.saving}
            disabled={profile.loading}
            onClick={() => void saveProfile()}
          >
            Save reader instructions
          </Button>
          <Button
            disabled={profile.loading || profile.saving}
            onClick={() =>
              setProfile((prev) => ({
                ...prev,
                instructions: "",
                saved: false,
              }))
            }
          >
            Clear
          </Button>
          <span aria-live="polite">
            {profile.saved ? (
              <Text type="success">Saved for all your public shares.</Text>
            ) : null}
          </span>
        </Space>
        {profile.error ? (
          <Alert type="error" showIcon title={profile.error} />
        ) : null}
        {profile.instructions.trim() ? (
          <Card size="small" title="Reader preview">
            <StaticMarkdown value={profile.instructions.trim()} />
          </Card>
        ) : null}
      </Space>
    </Card>
  );
}

function PublicSharesPage() {
  const projectMap = useTypedRedux("projects", "project_map");
  const legacyMigrationEnabled = !!useTypedRedux(
    "customize",
    "legacy_migration_enabled",
  );
  const [state, setState] = useState<PublicSharesState>({
    error: "",
    loading: false,
    shares: [],
    totalCount: 0,
  });
  const [selectedShareIds, setSelectedShareIds] = useState<string[]>([]);
  const [legacyState, setLegacyState] = useState<LegacyPublicSharesState>({
    error: "",
    hasInventory: false,
    loading: false,
    page: 1,
    pageSize: 25,
    query: "",
    shares: [],
    totalCount: 0,
  });
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
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
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
  const currentShareByLegacyId = useMemo(() => {
    const result = new Map<string, PublicDirectoryShareSummary>();
    for (const share of state.shares) {
      if (share.legacy_public_path_id) {
        result.set(share.legacy_public_path_id, share);
      }
    }
    return result;
  }, [state.shares]);
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

  async function loadLegacyShares(
    page = legacyState.page,
    pageSize = legacyState.pageSize,
    query = legacyState.query,
  ) {
    if (!legacyMigrationEnabled) {
      setLegacyState({
        error: "",
        hasInventory: false,
        loading: false,
        page: 1,
        pageSize,
        query,
        shares: [],
        totalCount: 0,
      });
      return;
    }
    setLegacyState((prev) => ({ ...prev, error: "", loading: true }));
    try {
      const result =
        await webapp_client.conat_client.hub.legacyMigration.listPublicShares({
          limit: pageSize,
          offset: (page - 1) * pageSize,
          query,
        });
      setLegacyState((prev) => ({
        error: "",
        hasInventory: prev.hasInventory || result.total_count > 0,
        loading: false,
        page,
        pageSize,
        query,
        shares: result.shares,
        totalCount: result.total_count,
      }));
    } catch (err) {
      setLegacyState((prev) => ({
        ...prev,
        error: normalizeUserFacingError(err).message,
        loading: false,
      }));
    }
  }

  async function loadAllShares() {
    await Promise.all([
      loadShares(),
      loadLegacyShares(
        legacyState.page,
        legacyState.pageSize,
        legacyState.query,
      ),
    ]);
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
        failures.length = 0;
        for (const share of shares) {
          try {
            await webapp_client.conat_client.hub.publicDirectoryShares.update({
              id: share.id,
              ...updateForShare(share),
            });
          } catch (err) {
            if (isFreshAuthRequiredError(err)) {
              throw err;
            }
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
    void Promise.all([loadShares(), loadLegacyShares(1, 25, "")]);
  }, [legacyMigrationEnabled]);

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
    <Space vertical size="large" style={{ width: "100%" }}>
      <PublicSharePublisherProfileCard />
      <Card>
        <Space vertical size="middle" style={{ width: "100%" }}>
          <div>
            <Text type="secondary">
              These are public or unlisted file and directory shares owned by
              projects you can administer. A retained cocalc.com publication
              becomes active here after its corresponding project is restored;
              the historical inventory below also shows publications whose
              projects have not been restored.
            </Text>
          </div>

          <Alert
            type="info"
            showIcon
            style={PUBLIC_SHARES_NOTICE_STYLE}
            title={
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
            <Button
              onClick={() => void loadAllShares()}
              loading={state.loading || legacyState.loading}
            >
              Refresh
            </Button>
            <Text type="secondary">
              Showing {state.shares.length.toLocaleString()} of{" "}
              {state.totalCount.toLocaleString()} shares.
            </Text>
          </Space>

          {state.error ? (
            <Alert type="error" showIcon title={state.error} />
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
                renderCell: (_checked, share, _index, checkbox) =>
                  cloneElement(
                    checkbox as ReactElement<{ "aria-label"?: string }>,
                    {
                      "aria-label": `Select share ${share.slug}`,
                    },
                  ),
                onChange: (keys) =>
                  setSelectedShareIds(keys.map((key) => `${key}`)),
              }}
              scroll={{ x: 1310 }}
              tableLayout="fixed"
              columns={[
                {
                  title: "Share",
                  dataIndex: "slug",
                  width: SHARE_COLUMN_WIDTH,
                  sorter: (a, b) =>
                    compareText(
                      shareDisplaySortText(a),
                      shareDisplaySortText(b),
                    ),
                  render: (_value, share) => {
                    const href = shareHref(share.slug);
                    return (
                      <Space
                        vertical
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
                  sorter: (a, b) =>
                    compareText(shareStatusSortText(a), shareStatusSortText(b)),
                  render: (_value, share) => (
                    <Space vertical size={4}>
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
                  title: (
                    <Tooltip title="When the public-share metadata was last changed. This is not the last edit time of the shared content.">
                      <span>Metadata updated</span>
                    </Tooltip>
                  ),
                  width: 170,
                  defaultSortOrder: "descend",
                  sorter: (a, b) =>
                    shareMetadataUpdatedTimestamp(a) -
                    shareMetadataUpdatedTimestamp(b),
                  render: (_value, share) => {
                    const date = shareMetadataUpdatedDate(share);
                    return date ? (
                      <Space vertical size={0}>
                        <TimeAgo date={date} />
                        <Text type="secondary">
                          {date.toLocaleDateString()}
                        </Text>
                      </Space>
                    ) : (
                      <Text type="secondary">-</Text>
                    );
                  },
                },
                {
                  title: "Updated by",
                  width: 180,
                  sorter: (a, b) =>
                    compareText(shareActorSortText(a), shareActorSortText(b)),
                  render: (_value, share) => {
                    const updatedBy = share.updated_by ?? share.created_by;
                    return (
                      <Space vertical size={0}>
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
                  sorter: (a, b) =>
                    compareText(
                      shareProjectPathSortText(a),
                      shareProjectPathSortText(b),
                    ),
                  render: (_value, share) => {
                    const archived =
                      projectMap?.getIn?.([
                        share.project_id,
                        "state",
                        "state",
                      ]) == "archived";
                    return (
                      <Space vertical size={2}>
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
      {legacyState.hasInventory || legacyState.error ? (
        <Card title="Legacy cocalc.com publications">
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Alert
              type="info"
              showIcon
              message="Legacy published files and folders require project restoration"
              description={
                <span>
                  A publication from cocalc.com becomes available here only
                  after a collaborator explicitly restores its corresponding
                  project. Restore projects from{" "}
                  <a href="/settings/legacy-migration">
                    Legacy migration settings
                  </a>
                  . Restoring a project replays its retained publication
                  metadata; CoCalc does not restore projects merely because
                  somebody visits an old shared URL.
                </span>
              }
            />
            {legacyState.error ? (
              <Alert type="error" showIcon message={legacyState.error} />
            ) : null}
            <Text type="secondary">
              {legacyState.totalCount.toLocaleString()} retained legacy
              publication(s) match. Search by path, title, project, or legacy
              identifier.
            </Text>
            <Input.Search
              allowClear
              defaultValue={legacyState.query}
              placeholder="Search legacy publications"
              onSearch={(query) =>
                void loadLegacyShares(1, legacyState.pageSize, query.trim())
              }
              style={{ maxWidth: 520 }}
            />
            <Table<LegacyMigrationPublicShareSummary>
              rowKey="legacy_public_path_id"
              dataSource={legacyState.shares}
              loading={legacyState.loading}
              pagination={{
                current: legacyState.page,
                pageSize: legacyState.pageSize,
                total: legacyState.totalCount,
                showSizeChanger: true,
                onChange: (page, pageSize) =>
                  void loadLegacyShares(page, pageSize, legacyState.query),
              }}
              scroll={{ x: 1050 }}
              tableLayout="fixed"
              columns={[
                {
                  title: "Published path",
                  width: 360,
                  render: (_value, legacyShare) => {
                    const currentShare = currentShareByLegacyId.get(
                      legacyShare.legacy_public_path_id,
                    );
                    const label =
                      legacyShare.title || projectPathLabel(legacyShare.path);
                    return (
                      <Space direction="vertical" size={2}>
                        {currentShare ? (
                          <a
                            href={shareHref(currentShare.slug)}
                            target="_blank"
                            rel="noreferrer"
                            style={WRAPPING_CELL_TEXT_STYLE}
                          >
                            {label}
                          </a>
                        ) : legacyShare.legacy_url ? (
                          <a
                            href={legacyShare.legacy_url}
                            target="_blank"
                            rel="noreferrer"
                            style={WRAPPING_CELL_TEXT_STYLE}
                          >
                            {label}
                          </a>
                        ) : (
                          <Text style={WRAPPING_CELL_TEXT_STYLE}>{label}</Text>
                        )}
                        <Text code style={WRAPPING_CELL_TEXT_STYLE}>
                          {projectPathLabel(legacyShare.path)}
                        </Text>
                        <Space size={4} wrap>
                          <Tag>{legacyShare.path_type}</Tag>
                          <Text type="secondary" copyable>
                            {legacyShare.legacy_public_path_id}
                          </Text>
                        </Space>
                      </Space>
                    );
                  },
                },
                {
                  title: "Legacy project",
                  width: 310,
                  render: (_value, legacyShare) => (
                    <Space direction="vertical" size={2}>
                      <Text strong>
                        {legacyShare.project_title || "Untitled project"}
                      </Text>
                      <Text code style={WRAPPING_CELL_TEXT_STYLE}>
                        {legacyShare.legacy_project_id}
                      </Text>
                      {legacyShare.project_id ? (
                        <a href={`/projects/${legacyShare.project_id}/files/`}>
                          Open restored project
                        </a>
                      ) : (
                        <a
                          href={legacyMigrationProjectHref(
                            legacyShare.legacy_project_id,
                          )}
                        >
                          Select project for restoration
                        </a>
                      )}
                    </Space>
                  ),
                },
                {
                  title: "Status",
                  width: 210,
                  render: (_value, legacyShare) => {
                    const currentShare = currentShareByLegacyId.get(
                      legacyShare.legacy_public_path_id,
                    );
                    const replayPending =
                      legacyShare.restore_status === "restored" &&
                      currentShare == null;
                    const verificationPending =
                      legacyShare.restore_status === "restored" &&
                      currentShare?.availability_status === "pending";
                    return (
                      <Space direction="vertical" size={4}>
                        {legacyShareStatusTag({
                          legacyShare,
                          currentShare,
                        })}
                        {legacyShare.restore_status ? (
                          <Text type="secondary">
                            Restore: {legacyShare.restore_status}
                          </Text>
                        ) : null}
                        {replayPending ? (
                          <Text type="secondary">
                            Project files are restored, but this publication has
                            not yet been recreated.
                          </Text>
                        ) : null}
                        {verificationPending ? (
                          <Text type="secondary">
                            Project files are restored, but CoCalc has not yet
                            verified this published path.
                          </Text>
                        ) : null}
                      </Space>
                    );
                  },
                },
                {
                  title: "Last edited",
                  width: 170,
                  defaultSortOrder: "descend",
                  sorter: (left, right) =>
                    legacyShareTimestamp(left) - legacyShareTimestamp(right),
                  render: (_value, legacyShare) => {
                    const date = legacyShareDate(legacyShare);
                    return date ? <TimeAgo date={date} /> : <Text>-</Text>;
                  },
                },
              ]}
            />
          </Space>
        </Card>
      ) : null}
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
        <Space vertical size="middle" style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            title="Selected shares will offer temporary membership on copy."
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
              title="No managed site-license pools are available for your account."
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
    defaultMessage: "Manage published files and directories in your projects.",
  }),
  icon: "share-square",
  key: "public-shares",
  label: defineMessage({
    id: "account.settings.public-shares.label",
    defaultMessage: "Public shares",
  }),
  title: defineMessage({
    id: "account.settings.public-shares.title",
    defaultMessage: "Public Shares",
  }),
} satisfies SettingsPageDefinition;
