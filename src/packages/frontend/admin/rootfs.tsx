/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Input,
  Popconfirm,
  Tooltip,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";

import { React } from "@cocalc/frontend/app-framework";
import { ErrorDisplay, Loading, TimeAgo } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  RootfsAdminCatalogEntry,
  RootfsImageEvent,
} from "@cocalc/util/rootfs-images";
import { plural } from "@cocalc/util/misc";

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

function scanTag(entry: RootfsAdminCatalogEntry): React.ReactNode {
  switch (entry.scan_status) {
    case "clean":
      return <Tag color="green">clean</Tag>;
    case "findings":
      return <Tag color="orange">findings</Tag>;
    case "error":
      return <Tag color="red">error</Tag>;
    case "pending":
      return <Tag color="blue">pending</Tag>;
    default:
      return <Tag>unknown</Tag>;
  }
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
  if (blockers.projects_using_release) {
    items.push(
      `${blockers.projects_using_release} ${plural(blockers.projects_using_release, "project")}`,
    );
  }
  if (blockers.catalog_entries_using_release) {
    items.push(
      `${blockers.catalog_entries_using_release} ${plural(blockers.catalog_entries_using_release, "catalog entry")}`,
    );
  }
  if (blockers.prepull_entries_using_release) {
    items.push(
      `${blockers.prepull_entries_using_release} ${plural(blockers.prepull_entries_using_release, "prepull entry")}`,
    );
  }
  if (blockers.child_releases) {
    items.push(
      `${blockers.child_releases} ${plural(blockers.child_releases, "child release")}`,
    );
  }
  return (
    <Space direction="vertical" size={0}>
      <Typography.Text style={{ fontSize: 12 }}>
        {items.join(", ")}
      </Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Total: {blockers.total}
      </Typography.Text>
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
    <Space direction="vertical" size={0}>
      {lines}
    </Space>
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
    <Space direction="vertical" size={0}>
      {entry.events.map((event) => (
        <Space
          key={event.event_id}
          direction="vertical"
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

export function RootfsAdmin() {
  const hub = webapp_client.conat_client.hub;
  const [rows, setRows] = React.useState<RootfsAdminCatalogEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string>("");
  const [search, setSearch] = React.useState("");
  const [gcRunning, setGcRunning] = React.useState(false);
  const [actionImageId, setActionImageId] = React.useState<string>();

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await hub.system.getRootfsCatalogAdmin({});
      setRows(data ?? []);
      setError("");
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }, [hub]);

  React.useEffect(() => {
    load();
  }, [load]);

  const filtered = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((entry) =>
      [
        entry.label,
        entry.image,
        entry.owner_name,
        entry.owner_id,
        entry.visibility,
        ...(entry.tags ?? []),
      ]
        .filter(Boolean)
        .some((value) => `${value}`.toLowerCase().includes(needle)),
    );
  }, [rows, search]);

  const counts = React.useMemo(
    () => ({
      total: rows.length,
      deleted: rows.filter((entry) => entry.deleted).length,
      pendingDelete: rows.filter(
        (entry) => entry.release_gc_status === "pending_delete",
      ).length,
      blocked: rows.filter(
        (entry) => entry.blocked || entry.release_gc_status === "blocked",
      ).length,
    }),
    [rows],
  );

  async function requestDelete(entry: RootfsAdminCatalogEntry) {
    setActionImageId(entry.id);
    try {
      const result = await hub.system.requestRootfsImageDeletion({
        image_id: entry.id,
        reason: "admin-ui cleanup",
      });
      message.success(
        result.blockers.total > 0
          ? "Catalog entry deleted; release remains blocked by references."
          : "Catalog entry deleted and release queued for GC.",
      );
      await load();
    } catch (err) {
      message.error(`Failed to delete RootFS image: ${err}`);
    } finally {
      setActionImageId(undefined);
    }
  }

  async function saveEntry(
    entry: RootfsAdminCatalogEntry,
    patch: Partial<RootfsAdminCatalogEntry>,
    success: string,
  ) {
    setActionImageId(entry.id);
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
      });
      message.success(success);
      await load();
    } catch (err) {
      message.error(`Failed to update RootFS image: ${err}`);
    } finally {
      setActionImageId(undefined);
    }
  }

  async function runGc() {
    setGcRunning(true);
    try {
      const result = await hub.system.runRootfsReleaseGc({ limit: 100 });
      message.success(
        `RootFS GC deleted ${result.deleted} ${plural(result.deleted, "release")} and blocked ${result.blocked}.`,
      );
      await load();
    } catch (err) {
      message.error(`Failed to run RootFS GC: ${err}`);
    } finally {
      setGcRunning(false);
    }
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary">
        Manage all RootFS catalog entries and inspect central lifecycle state.
        Deleting an image here removes the catalog entry immediately and lets
        central release GC reclaim storage later when safe.
      </Typography.Paragraph>
      <Space wrap>
        <Input.Search
          allowClear
          placeholder="Search label, image, owner, visibility, or tags"
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
        <Tag color="orange">{counts.pendingDelete} pending release GC</Tag>
        <Tag color="gold">{counts.blocked} blocked</Tag>
      </Space>
      {error ? <ErrorDisplay error={error} /> : null}
      {loading && rows.length === 0 ? (
        <Loading />
      ) : (
        <Table<RootfsAdminCatalogEntry>
          rowKey="id"
          size="small"
          dataSource={filtered}
          pagination={{ pageSize: 20, showSizeChanger: true }}
          columns={[
            {
              title: "Label",
              key: "label",
              render: (_, entry) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text strong>{entry.label}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {entry.owner_name ?? entry.owner_id ?? "builtin"}
                  </Typography.Text>
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
                <Space direction="vertical" size={0}>
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
                <Space direction="vertical" size={0}>
                  <Space wrap>
                    {scanTag(entry)}
                    {entry.scan_tool ? <Tag>{entry.scan_tool}</Tag> : null}
                  </Space>
                  {entry.scan?.summary ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {entry.scan.summary}
                    </Typography.Text>
                  ) : null}
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
                        loading={actionImageId === entry.id}
                        onClick={() =>
                          saveEntry(
                            entry,
                            { hidden: false },
                            "RootFS image is visible again.",
                          )
                        }
                      >
                        Unhide
                      </Button>
                    ) : (
                      <Button
                        size="small"
                        loading={actionImageId === entry.id}
                        onClick={() =>
                          saveEntry(
                            entry,
                            { hidden: true },
                            "RootFS image hidden.",
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
                        loading={actionImageId === entry.id}
                        onClick={() =>
                          saveEntry(
                            entry,
                            { blocked: false, blocked_reason: undefined },
                            "RootFS image unblocked.",
                          )
                        }
                      >
                        Unblock
                      </Button>
                    ) : (
                      <Tooltip title="Prevent new selections while preserving existing projects.">
                        <Button
                          size="small"
                          loading={actionImageId === entry.id}
                          onClick={() =>
                            saveEntry(
                              entry,
                              {
                                blocked: true,
                                blocked_reason:
                                  entry.blocked_reason ?? "Blocked by admin",
                              },
                              "RootFS image blocked.",
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
                        loading={actionImageId === entry.id}
                      >
                        Delete
                      </Button>
                    </Popconfirm>
                  ) : (
                    <Typography.Text type="secondary">Deleted</Typography.Text>
                  )}
                </Space>
              ),
            },
          ]}
        />
      )}
      {!loading && filtered.length === 0 ? (
        <Alert
          type="info"
          showIcon
          message="No RootFS catalog entries match the current filter."
        />
      ) : null}
    </Space>
  );
}
