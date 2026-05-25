/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";

import { React } from "@cocalc/frontend/app-framework";
import {
  ErrorDisplay,
  Loading,
  TimeAgo,
  Tooltip,
} from "@cocalc/frontend/components";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import type { Host, HostRootfsImage } from "@cocalc/conat/hub/api/hosts";
import { RootfsScanStatus } from "@cocalc/frontend/rootfs/scan-status";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  RootfsAdminCatalogCounts,
  RootfsAdminCatalogEntry,
  RootfsImageEvent,
  RootfsStorageLocation,
} from "@cocalc/util/rootfs-images";
import { plural } from "@cocalc/util/misc";

const ROOTFS_SCAN_ADMIN_TIMEOUT_MS = 35 * 60 * 1000;
const ROOTFS_SCAN_HOST_CACHE_TIMEOUT_MS = 8 * 1000;
const ROOTFS_ADMIN_PAGE_SIZE = 20;

type RootfsAdminAction =
  | "download"
  | "delete"
  | "hide"
  | "unhide"
  | "block"
  | "unblock"
  | "scan";

type RootfsScanHostCandidate = {
  host: Host;
  cached: boolean;
  cache_entry?: HostRootfsImage;
  cache_error?: string;
};

function lifecycleTags(entry: RootfsAdminCatalogEntry): React.ReactNode[] {
  const tags: React.ReactNode[] = [];
  if (entry.official) tags.push(<Tag color="green">Official</Tag>);
  if (entry.prepull) tags.push(<Tag color="blue">Prepull</Tag>);
  if (entry.hidden) tags.push(<Tag color="orange">Hidden</Tag>);
  if (entry.blocked) tags.push(<Tag color="gold">Blocked</Tag>);
  if (entry.deleted) tags.push(<Tag color="red">Deleted</Tag>);
  switch (entry.release_gc_status) {
    case "pending_delete":
      tags.push(<Tag color="orange">Release pending delete</Tag>);
      break;
    case "blocked":
      tags.push(<Tag color="gold">Release GC blocked</Tag>);
      break;
    case "deleted":
      tags.push(<Tag color="red">Release deleted</Tag>);
      break;
  }
  return tags;
}

function blockerSummary(entry: RootfsAdminCatalogEntry): React.ReactNode {
  const blockers = entry.delete_blockers;
  if (!blockers) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Not pending deletion
      </Typography.Text>
    );
  }
  if (blockers.total === 0) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        No blockers
      </Typography.Text>
    );
  }
  const items: string[] = [];
  const nextSteps: string[] = [];
  if (blockers.projects_using_release) {
    items.push(
      `${blockers.projects_using_release} ${plural(blockers.projects_using_release, "project")}`,
    );
    nextSteps.push("switch or delete projects still using this release");
  }
  if (blockers.catalog_entries_using_release) {
    items.push(
      `${blockers.catalog_entries_using_release} ${plural(blockers.catalog_entries_using_release, "catalog entry")}`,
    );
    nextSteps.push("delete or repoint other catalog entries using it");
  }
  if (blockers.prepull_entries_using_release) {
    items.push(
      `${blockers.prepull_entries_using_release} ${plural(blockers.prepull_entries_using_release, "prepull entry")}`,
    );
    nextSteps.push("disable pre-pull on entries that still reference it");
  }
  if (blockers.child_releases) {
    items.push(
      `${blockers.child_releases} ${plural(blockers.child_releases, "child release")}`,
    );
    nextSteps.push("delete child releases or repack them as full releases");
  }
  return (
    <Space orientation="vertical" size={0}>
      <Typography.Text style={{ fontSize: 12 }}>
        {items.join(", ")}
      </Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Total: {blockers.total}
      </Typography.Text>
      {nextSteps.length > 0 ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          To unblock GC: {nextSteps.join("; ")}.
        </Typography.Text>
      ) : null}
    </Space>
  );
}

function lifecycleHistory(entry: RootfsAdminCatalogEntry): React.ReactNode {
  const lines: React.ReactNode[] = [];
  if (entry.blocked_at || entry.blocked_by) {
    lines.push(
      <Typography.Text key="blocked" type="secondary" style={{ fontSize: 12 }}>
        Last blocked{" "}
        {entry.blocked_at ? <TimeAgo date={entry.blocked_at} /> : null}
        {entry.blocked_by ? ` by ${entry.blocked_by}` : ""}
      </Typography.Text>,
    );
  }
  if (entry.hidden_at || entry.hidden_by) {
    lines.push(
      <Typography.Text key="hidden" type="secondary" style={{ fontSize: 12 }}>
        Last hidden{" "}
        {entry.hidden_at ? <TimeAgo date={entry.hidden_at} /> : null}
        {entry.hidden_by ? ` by ${entry.hidden_by}` : ""}
      </Typography.Text>,
    );
  }
  if (entry.deleted_at || entry.deleted_by) {
    lines.push(
      <Typography.Text key="deleted" type="secondary" style={{ fontSize: 12 }}>
        Deleted {entry.deleted_at ? <TimeAgo date={entry.deleted_at} /> : null}
        {entry.deleted_by ? ` by ${entry.deleted_by}` : ""}
      </Typography.Text>,
    );
  }
  if (!lines.length) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        No lifecycle history yet
      </Typography.Text>
    );
  }
  return (
    <Space orientation="vertical" size={0}>
      {lines}
    </Space>
  );
}

function releaseMetadata(entry: RootfsAdminCatalogEntry): React.ReactNode {
  if (!entry.family && !entry.version && !entry.channel) {
    return null;
  }
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {[
        entry.family ? `family=${entry.family}` : null,
        entry.version ? `version=${entry.version}` : null,
        entry.channel ? `channel=${entry.channel}` : null,
      ]
        .filter(Boolean)
        .join(" ")}
    </Typography.Text>
  );
}

function eventTitle(event: RootfsImageEvent): string {
  switch (event.event_type) {
    case "catalog_created":
      return "Catalog entry created";
    case "hidden":
      return "Hidden";
    case "unhidden":
      return "Unhidden";
    case "blocked":
      return "Blocked";
    case "unblocked":
      return "Unblocked";
    case "deleted":
      return "Deleted";
    case "release_gc_pending":
      return "Release queued for GC";
    case "release_gc_blocked":
      return "Release GC blocked";
    case "release_gc_deleted":
      return "Release deleted";
    case "release_gc_failed":
      return "Release GC failed";
    default:
      return event.event_type;
  }
}

function eventSummary(event: RootfsImageEvent): string | undefined {
  if (event.reason) return event.reason;
  const blockers = event.payload?.blockers;
  if (blockers?.total != null) {
    return `blockers=${blockers.total}`;
  }
  if (event.payload?.blocked_reason) {
    return `${event.payload.blocked_reason}`;
  }
}

function recentEvents(entry: RootfsAdminCatalogEntry): React.ReactNode {
  if (!entry.events?.length) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        No recent events
      </Typography.Text>
    );
  }
  return (
    <Space orientation="vertical" size={0}>
      {entry.events.map((event) => (
        <Space
          key={event.event_id}
          orientation="vertical"
          size={0}
          style={{ width: "100%" }}
        >
          <Typography.Text style={{ fontSize: 12 }}>
            {eventTitle(event)}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <TimeAgo date={event.created} />
            {event.actor_name || event.actor_account_id
              ? ` by ${event.actor_name ?? event.actor_account_id}`
              : ""}
          </Typography.Text>
          {eventSummary(event) ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {eventSummary(event)}
            </Typography.Text>
          ) : null}
        </Space>
      ))}
    </Space>
  );
}

function storageStatusTag(status?: string): React.ReactNode {
  if (!status || status === "ready") return null;
  if (status === "failed") {
    return <Tag color="red">failed</Tag>;
  }
  if (status === "pending") {
    return <Tag color="orange">pending</Tag>;
  }
  return <Tag>{status}</Tag>;
}

function storageLabel(location: RootfsStorageLocation): string {
  return (
    location.repo_selector ?? `${location.backend}:${location.artifact_format}`
  );
}

function storageFormatLabel(
  locations: RootfsStorageLocation[],
): string | undefined {
  return locations.length > 0 ? "rustic" : undefined;
}

function storageLocationLabel(location: RootfsStorageLocation): string {
  if (location.region) {
    return `${location.role === "primary" ? "Primary" : "Replica"} ${location.region}`;
  }
  if (location.backend === "rest") {
    return `${location.role === "primary" ? "Primary" : "Replica"} self-host`;
  }
  if (location.bucket_name) {
    return `${location.role === "primary" ? "Primary" : "Replica"} ${location.bucket_name}`;
  }
  return `${location.role === "primary" ? "Primary" : "Replica"} ${storageLabel(location)}`;
}

function storageTooltip(location: RootfsStorageLocation): React.ReactNode {
  return (
    <Space orientation="vertical" size={0}>
      <Typography.Text code style={{ fontSize: 12 }}>
        {storageLabel(location)}
      </Typography.Text>
      {location.bucket_name ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          bucket: {location.bucket_name}
          {location.bucket_purpose ? ` (${location.bucket_purpose})` : ""}
        </Typography.Text>
      ) : null}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {location.artifact_path}
      </Typography.Text>
      {location.status && location.status !== "ready" ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          status: {location.status}
        </Typography.Text>
      ) : null}
    </Space>
  );
}

function storageSummary(entry: RootfsAdminCatalogEntry): React.ReactNode {
  if (!entry.release_id) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        External or builtin image
      </Typography.Text>
    );
  }
  if (!entry.storage_locations?.length) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Managed release without storage metadata
      </Typography.Text>
    );
  }
  const formatLabel = storageFormatLabel(entry.storage_locations);
  return (
    <Space wrap size={[4, 4]}>
      {formatLabel ? <Tag color="purple">{formatLabel}</Tag> : null}
      {entry.storage_locations.map((location, index) => (
        <Tooltip
          key={`${location.role}-${location.backend}-${location.region ?? "site"}-${location.artifact_path}-${index}`}
          title={storageTooltip(location)}
          placement="topLeft"
        >
          <Tag color={location.role === "primary" ? "blue" : "default"}>
            {storageLocationLabel(location)}
          </Tag>
        </Tooltip>
      ))}
      {entry.storage_locations.map((location, index) => {
        const status = storageStatusTag(location.status);
        if (!status) return null;
        return (
          <React.Fragment
            key={`status-${location.role}-${location.status ?? "ready"}-${location.region ?? "site"}-${index}`}
          >
            {status}
          </React.Fragment>
        );
      })}
    </Space>
  );
}

function hostDisplayName(host: Host): string {
  const name = `${host.name ?? ""}`.trim();
  return name || host.id;
}

function hostIsAvailableForScan(host: Host): boolean {
  return !host.deleted && host.status === "running";
}

function hostHasRootfsImage({
  entry,
  image,
}: {
  entry: RootfsAdminCatalogEntry;
  image: HostRootfsImage;
}): boolean {
  return (
    image.image === entry.image ||
    (!!entry.release_id && image.release_id === entry.release_id)
  );
}

function compareScanHostCandidates(
  a: RootfsScanHostCandidate,
  b: RootfsScanHostCandidate,
): number {
  if (a.cached !== b.cached) return a.cached ? -1 : 1;
  return hostDisplayName(a.host).localeCompare(hostDisplayName(b.host));
}

function scanHostCandidateLabel(candidate: RootfsScanHostCandidate) {
  const host = candidate.host;
  const details = [
    host.region,
    host.bay_id ? `bay ${host.bay_id}` : undefined,
    host.status,
  ].filter(Boolean);
  return (
    <Space direction="vertical" size={0}>
      <Space wrap>
        <Typography.Text strong>{hostDisplayName(host)}</Typography.Text>
        <Typography.Text type="secondary" copyable={{ text: host.id }}>
          {host.id}
        </Typography.Text>
        {candidate.cached ? (
          <Tag color="green">RootFS cached</Tag>
        ) : (
          <Tag>Will pull first</Tag>
        )}
        {candidate.cache_error ? <Tag color="orange">Cache unknown</Tag> : null}
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {details.join(" · ") || "online host"}
        {candidate.cache_entry?.size_bytes
          ? ` · cached ${Math.round(candidate.cache_entry.size_bytes / 1_000_000_000)} GB`
          : ""}
        {candidate.cache_error ? ` · ${candidate.cache_error}` : ""}
      </Typography.Text>
    </Space>
  );
}

export function RootfsAdmin() {
  const hub = webapp_client.conat_client.hub;
  const [rows, setRows] = React.useState<RootfsAdminCatalogEntry[]>([]);
  const [total, setTotal] = React.useState(0);
  const [counts, setCounts] = React.useState<RootfsAdminCatalogCounts>({
    total: 0,
    deleted: 0,
    pending_delete: 0,
    blocked: 0,
    official_unscanned: 0,
    official_critical: 0,
    official_scan_failed: 0,
  });
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(ROOTFS_ADMIN_PAGE_SIZE);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string>("");
  const [search, setSearch] = React.useState("");
  const [gcRunning, setGcRunning] = React.useState(false);
  const [activeAction, setActiveAction] = React.useState<{
    image_id: string;
    action: RootfsAdminAction;
  }>();
  const [scanEntry, setScanEntry] =
    React.useState<RootfsAdminCatalogEntry | null>(null);
  const [scanHosts, setScanHosts] = React.useState<RootfsScanHostCandidate[]>(
    [],
  );
  const [scanHostId, setScanHostId] = React.useState<string>();
  const [scanHostsLoading, setScanHostsLoading] = React.useState(false);
  const [scanHostError, setScanHostError] = React.useState<string>("");

  function actionLoading(
    entry: RootfsAdminCatalogEntry,
    action: RootfsAdminAction,
  ): boolean {
    return (
      activeAction?.image_id === entry.id && activeAction.action === action
    );
  }

  const load = React.useCallback(
    async (nextPage = 1, nextPageSize = pageSize) => {
      setLoading(true);
      try {
        const data = await hub.system.getRootfsCatalogAdminPage({
          limit: nextPageSize,
          offset: Math.max(0, nextPage - 1) * nextPageSize,
          query: search.trim() || undefined,
          sort: "updated",
          direction: "desc",
        });
        setRows(data.entries ?? []);
        setTotal(data.total ?? 0);
        setCounts(data.counts);
        setPage(nextPage);
        setPageSize(nextPageSize);
        setError("");
      } catch (err) {
        setError(`${err}`);
      } finally {
        setLoading(false);
      }
    },
    [hub, pageSize, search],
  );

  React.useEffect(() => {
    const timeout = setTimeout(() => {
      load(1, pageSize);
    }, 250);
    return () => clearTimeout(timeout);
  }, [load, pageSize, search]);

  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => {
      message.error(`RootFS admin action failed: ${err}`);
      void load();
    },
  });

  async function requestDelete(entry: RootfsAdminCatalogEntry) {
    try {
      await runFreshAuthAction(async () => {
        setActiveAction({ image_id: entry.id, action: "delete" });
        try {
          const result = await hub.system.requestRootfsImageDeletion({
            image_id: entry.id,
            reason: "admin-ui cleanup",
            browser_id: webapp_client.browser_id,
          });
          message.success(
            result.blockers.total > 0
              ? "Catalog entry deleted; release remains blocked by references."
              : "Catalog entry deleted and release queued for GC.",
          );
          await load();
        } finally {
          setActiveAction(undefined);
        }
      });
    } catch (err) {
      message.error(`Failed to delete RootFS image: ${err}`);
      await load();
      setActiveAction(undefined);
    }
  }

  async function saveEntry(
    entry: RootfsAdminCatalogEntry,
    patch: Partial<RootfsAdminCatalogEntry>,
    success: string,
    action: RootfsAdminAction,
  ) {
    try {
      await runFreshAuthAction(async () => {
        setActiveAction({ image_id: entry.id, action });
        try {
          await hub.system.saveRootfsCatalogEntry({
            image_id: entry.id,
            image: entry.image,
            label: entry.label,
            description: entry.description,
            visibility: entry.visibility,
            arch: entry.arch,
            gpu: entry.gpu,
            size_gb: entry.size_gb,
            tags: entry.tags,
            theme: entry.theme,
            family: entry.family,
            version: entry.version,
            channel: entry.channel,
            supersedes_image_id: entry.supersedes_image_id,
            official: patch.official ?? entry.official,
            prepull: patch.prepull ?? entry.prepull,
            hidden: patch.hidden ?? entry.hidden,
            blocked: patch.blocked ?? entry.blocked,
            blocked_reason:
              patch.blocked === false
                ? undefined
                : (patch.blocked_reason ??
                  entry.blocked_reason ??
                  "Blocked by admin"),
            browser_id: webapp_client.browser_id,
          });
          message.success(success);
          await load();
        } finally {
          setActiveAction(undefined);
        }
      });
    } catch (err) {
      message.error(`Failed to update RootFS image: ${err}`);
      await load();
      setActiveAction(undefined);
    }
  }

  async function runGc() {
    try {
      await runFreshAuthAction(async () => {
        setGcRunning(true);
        try {
          const result = await hub.system.runRootfsReleaseGc({
            limit: 100,
            browser_id: webapp_client.browser_id,
          });
          message.success(
            `RootFS GC deleted ${result.deleted} ${plural(result.deleted, "release")} and blocked ${result.blocked}.`,
          );
          await load();
        } finally {
          setGcRunning(false);
        }
      });
    } catch (err) {
      message.error(`Failed to run RootFS GC: ${err}`);
      await load();
      setGcRunning(false);
    }
  }

  async function loadScanHosts(entry: RootfsAdminCatalogEntry) {
    setScanHostsLoading(true);
    setScanHostError("");
    setScanHosts([]);
    setScanHostId(undefined);
    try {
      const hosts = await hub.hosts.listHosts({
        admin_view: true,
        show_all: true,
      });
      const onlineHosts = hosts.filter(hostIsAvailableForScan);
      const candidates = await Promise.all(
        onlineHosts.map(async (host): Promise<RootfsScanHostCandidate> => {
          try {
            const cachedImages = await hub.hosts.listHostRootfsImages({
              id: host.id,
              timeout: ROOTFS_SCAN_HOST_CACHE_TIMEOUT_MS,
            });
            const cache_entry = cachedImages.find((image) =>
              hostHasRootfsImage({ entry, image }),
            );
            return {
              host,
              cached: !!cache_entry,
              cache_entry,
            };
          } catch (err) {
            return {
              host,
              cached: false,
              cache_error: `${err}`,
            };
          }
        }),
      );
      candidates.sort(compareScanHostCandidates);
      setScanHosts(candidates);
      setScanHostId(candidates[0]?.host.id);
      if (candidates.length === 0) {
        setScanHostError("No online project hosts are available for scanning.");
      }
    } catch (err) {
      setScanHostError(`${err}`);
    } finally {
      setScanHostsLoading(false);
    }
  }

  async function openScanHostPicker(entry: RootfsAdminCatalogEntry) {
    if (!entry.release_id) {
      message.error("This catalog entry does not reference a managed release.");
      return;
    }
    setScanEntry(entry);
    await loadScanHosts(entry);
  }

  async function runScan(entry: RootfsAdminCatalogEntry, hostId: string) {
    const release_id = entry.release_id;
    if (!release_id) {
      message.error("This catalog entry does not reference a managed release.");
      return;
    }
    try {
      await runFreshAuthAction(async () => {
        setActiveAction({ image_id: entry.id, action: "scan" });
        try {
          const result = await hub.system.scanRootfsRelease({
            release_id,
            host_id: hostId,
            browser_id: webapp_client.browser_id,
            timeout: ROOTFS_SCAN_ADMIN_TIMEOUT_MS,
          });
          message.success(`RootFS scan ${result.status}: ${entry.label}`);
          await load();
          setScanEntry(null);
        } finally {
          setActiveAction(undefined);
        }
      });
    } catch (err) {
      message.error(`Failed to scan RootFS image: ${err}`);
      await load();
      setActiveAction(undefined);
    }
  }

  async function runSelectedScan() {
    if (!scanEntry || !scanHostId) return;
    await runScan(scanEntry, scanHostId);
  }

  async function downloadScanReport(entry: RootfsAdminCatalogEntry) {
    const report_id = entry.scan?.report?.artifact_id;
    if (!report_id) return;
    setActiveAction({ image_id: entry.id, action: "download" });
    try {
      const report = await hub.system.getRootfsScanReport({ report_id });
      const blob = new Blob([JSON.stringify(report.report_json, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `rootfs-scan-${entry.id}-${report_id}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      message.error(`Failed to download scan report: ${err}`);
    } finally {
      setActiveAction(undefined);
    }
  }

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <FreshAuthModal {...freshAuthModalProps} />
      <Modal
        open={!!scanEntry}
        title={
          scanEntry ? `Scan RootFS image "${scanEntry.label}"` : "Scan RootFS"
        }
        okText="Start scan"
        onOk={() => void runSelectedScan()}
        onCancel={() => setScanEntry(null)}
        okButtonProps={{
          disabled: !scanHostId || scanHostsLoading,
          loading: scanEntry ? actionLoading(scanEntry, "scan") : false,
        }}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Paragraph type="secondary">
            Choose an online project host to run the scan. Hosts that already
            have this RootFS cached are listed first; otherwise the host will
            pull the RootFS before scanning.
          </Typography.Paragraph>
          {scanHostError ? (
            <Alert type="warning" showIcon message={scanHostError} />
          ) : null}
          {scanHostsLoading ? (
            <Loading />
          ) : (
            <Radio.Group
              value={scanHostId}
              onChange={(event) => setScanHostId(event.target.value)}
              style={{ width: "100%" }}
            >
              <Space
                direction="vertical"
                size="middle"
                style={{ width: "100%" }}
              >
                {scanHosts.map((candidate) => (
                  <Radio key={candidate.host.id} value={candidate.host.id}>
                    {scanHostCandidateLabel(candidate)}
                  </Radio>
                ))}
              </Space>
            </Radio.Group>
          )}
          {scanEntry ? (
            <Button
              size="small"
              onClick={() => void loadScanHosts(scanEntry)}
              loading={scanHostsLoading}
            >
              Refresh hosts
            </Button>
          ) : null}
        </Space>
      </Modal>
      <Typography.Paragraph type="secondary">
        Manage all RootFS catalog entries and inspect central lifecycle state.
        Deleting an image here removes the catalog entry immediately and lets
        central release GC reclaim storage later when safe.
      </Typography.Paragraph>
      <Space wrap>
        <Input.Search
          allowClear
          placeholder="Search label, image, owner, visibility, tags, or storage"
          style={{ width: 420, maxWidth: "100%" }}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onSearch={(value) => setSearch(value)}
        />
        <Button onClick={() => load()} loading={loading}>
          Refresh
        </Button>
        <Button onClick={() => runGc()} loading={gcRunning}>
          Run release GC
        </Button>
      </Space>
      <Space wrap>
        <Tag>{counts.total} catalog entries</Tag>
        <Tag color="red">{counts.deleted} deleted</Tag>
        <Tag color="orange">{counts.pending_delete} pending release GC</Tag>
        <Tag color="gold">{counts.blocked} blocked</Tag>
        <Tag>{counts.official_unscanned} official unscanned</Tag>
        <Tag color="red">{counts.official_critical} official critical</Tag>
        <Tag color="red">{counts.official_scan_failed} scan failed</Tag>
      </Space>
      {error ? <ErrorDisplay error={error} /> : null}
      {loading && rows.length === 0 ? (
        <Loading />
      ) : (
        <Table<RootfsAdminCatalogEntry>
          rowKey="id"
          size="small"
          dataSource={rows}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (value, range) => `${range[0]}-${range[1]} of ${value}`,
          }}
          onChange={(pagination) => {
            void load(pagination.current ?? 1, pagination.pageSize ?? pageSize);
          }}
          columns={[
            {
              title: "Label",
              key: "label",
              render: (_, entry) => (
                <Space orientation="vertical" size={0}>
                  <Typography.Text strong>{entry.label}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {entry.owner_name ?? entry.owner_id ?? "builtin"}
                  </Typography.Text>
                  {releaseMetadata(entry)}
                </Space>
              ),
            },
            {
              title: "Image",
              dataIndex: "image",
              key: "image",
              render: (value: string) => (
                <Typography.Text copyable={{ text: value }}>
                  <code>{value}</code>
                </Typography.Text>
              ),
            },
            {
              title: "Visibility",
              key: "visibility",
              render: (_, entry) => (
                <Space wrap>
                  <Tag>{entry.visibility ?? "public"}</Tag>
                  {entry.gpu ? <Tag color="purple">GPU</Tag> : null}
                </Space>
              ),
            },
            {
              title: "Lifecycle",
              key: "lifecycle",
              render: (_, entry) => (
                <Space orientation="vertical" size={0}>
                  <Space wrap>{lifecycleTags(entry)}</Space>
                  {entry.blocked_reason ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {entry.blocked_reason}
                    </Typography.Text>
                  ) : null}
                  {lifecycleHistory(entry)}
                </Space>
              ),
            },
            {
              title: "Storage",
              key: "storage",
              render: (_, entry) => storageSummary(entry),
            },
            {
              title: "Delete blockers",
              key: "blockers",
              render: (_, entry) => blockerSummary(entry),
            },
            {
              title: "Recent events",
              key: "events",
              render: (_, entry) => recentEvents(entry),
            },
            {
              title: "Scan",
              key: "scan",
              render: (_, entry) => (
                <Space orientation="vertical" size={0}>
                  <RootfsScanStatus entry={entry} />
                  {entry.scan?.report_url ? (
                    <Typography.Link
                      href={entry.scan.report_url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: 12 }}
                    >
                      View report
                    </Typography.Link>
                  ) : null}
                  {entry.scan?.report?.artifact_id ? (
                    <Button
                      size="small"
                      loading={actionLoading(entry, "download")}
                      onClick={() => downloadScanReport(entry)}
                    >
                      Download report
                    </Button>
                  ) : null}
                  {entry.scanned_at ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      <TimeAgo date={entry.scanned_at} />
                    </Typography.Text>
                  ) : null}
                </Space>
              ),
            },
            {
              title: "Actions",
              key: "actions",
              render: (_, entry) => (
                <Space wrap>
                  {!entry.deleted ? (
                    entry.hidden ? (
                      <Button
                        size="small"
                        loading={actionLoading(entry, "unhide")}
                        onClick={() =>
                          saveEntry(
                            entry,
                            { hidden: false },
                            "RootFS image is visible again.",
                            "unhide",
                          )
                        }
                      >
                        Unhide
                      </Button>
                    ) : (
                      <Button
                        size="small"
                        loading={actionLoading(entry, "hide")}
                        onClick={() =>
                          saveEntry(
                            entry,
                            { hidden: true },
                            "RootFS image hidden.",
                            "hide",
                          )
                        }
                      >
                        Hide
                      </Button>
                    )
                  ) : null}
                  {!entry.deleted ? (
                    entry.blocked ? (
                      <Button
                        size="small"
                        loading={actionLoading(entry, "unblock")}
                        onClick={() =>
                          saveEntry(
                            entry,
                            { blocked: false, blocked_reason: undefined },
                            "RootFS image unblocked.",
                            "unblock",
                          )
                        }
                      >
                        Unblock
                      </Button>
                    ) : (
                      <Tooltip title="Prevent new selections while preserving existing projects.">
                        <Button
                          size="small"
                          loading={actionLoading(entry, "block")}
                          onClick={() =>
                            saveEntry(
                              entry,
                              {
                                blocked: true,
                                blocked_reason:
                                  entry.blocked_reason ?? "Blocked by admin",
                              },
                              "RootFS image blocked.",
                              "block",
                            )
                          }
                        >
                          Block
                        </Button>
                      </Tooltip>
                    )
                  ) : null}
                  {!entry.deleted ? (
                    <Popconfirm
                      title="Delete this RootFS catalog entry?"
                      description="The catalog entry will disappear immediately. Underlying release bytes are reclaimed later by GC when safe."
                      okText="Delete"
                      cancelText="Cancel"
                      onConfirm={() => requestDelete(entry)}
                    >
                      <Button
                        size="small"
                        danger
                        loading={actionLoading(entry, "delete")}
                      >
                        Delete
                      </Button>
                    </Popconfirm>
                  ) : (
                    <Typography.Text type="secondary">Deleted</Typography.Text>
                  )}
                  {!entry.deleted ? (
                    <Button
                      size="small"
                      loading={actionLoading(entry, "scan")}
                      disabled={!entry.release_id}
                      onClick={() => void openScanHostPicker(entry)}
                    >
                      Scan now
                    </Button>
                  ) : null}
                </Space>
              ),
            },
          ]}
        />
      )}
      {!loading && rows.length === 0 ? (
        <Alert
          type="info"
          showIcon
          title="No RootFS catalog entries match the current filter."
        />
      ) : null}
    </Space>
  );
}
