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
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { useEffect, useState } from "react";
import { defineMessage } from "react-intl";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, Loading } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  LegacyMigrationArchiveEntry,
  LegacyMigrationArchiveIndex,
  LegacyMigrationImportProjectResult,
  LegacyMigrationProjectRestoreMode,
  LegacyMigrationProjectSummary,
} from "@cocalc/conat/hub/api/legacy-migration";
import type { SettingsPageDefinition } from "./settings-page";

const { Paragraph, Text } = Typography;

type LegacyMigrationState = {
  error: string;
  legacyAccountIds: string[];
  loading: boolean;
  projects: LegacyMigrationProjectSummary[];
  totalCount: number;
};

const PROJECT_LOAD_LIMIT = 1000;

function formatDate(value?: Date | string | null): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "Unknown";
  return date.toLocaleString();
}

function restoreTag(project: LegacyMigrationProjectSummary) {
  const status = project.restore_status;
  if (!status) return <Tag>not started</Tag>;
  if (status === "restored") return <Tag color="green">files restored</Tag>;
  if (status === "pending") return <Tag color="gold">file restore pending</Tag>;
  if (status === "failed") return <Tag color="red">file restore failed</Tag>;
  if (status === "restoring") return <Tag color="blue">restoring files</Tag>;
  if (status === "selection-pending") {
    return <Tag color="gold">waiting for file selection</Tag>;
  }
  if (status === "indexing") return <Tag color="blue">indexing archive</Tag>;
  if (status === "indexed") return <Tag color="cyan">archive indexed</Tag>;
  return <Tag>{status}</Tag>;
}

function formatDiskMb(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "Unknown";
  if (value < 1024) return `${Math.round(value).toLocaleString()} MB`;
  return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} GB`;
}

function importTag(project: LegacyMigrationProjectSummary) {
  if (project.import_status === "not-imported") {
    return <Tag>not imported</Tag>;
  }
  if (project.import_status === "imported") {
    return project.joined ? (
      <Tag color="green">imported for you</Tag>
    ) : (
      <Tag color="blue">already imported</Tag>
    );
  }
  if (project.import_status === "creating") {
    return <Tag color="gold">creating</Tag>;
  }
  return <Tag color="red">failed</Tag>;
}

function projectLink(project_id?: string | null) {
  if (!project_id) return null;
  return (
    <Button href={`/projects/${project_id}/files/`} size="small">
      Open
    </Button>
  );
}

function resultSummary(results: LegacyMigrationImportProjectResult[]): string {
  const imported = results.filter((result) => result.status === "imported");
  const joined = results.filter((result) => result.status === "joined");
  const failed = results.filter((result) => result.status === "failed");
  const creating = results.filter((result) => result.status === "creating");
  return [
    imported.length ? `${imported.length} imported` : "",
    joined.length ? `${joined.length} joined` : "",
    creating.length ? `${creating.length} still creating` : "",
    failed.length ? `${failed.length} failed` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function pathLines(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  );
}

function archiveSummaryFromProject(
  project: LegacyMigrationProjectSummary,
): Partial<LegacyMigrationArchiveIndex> | undefined {
  const index = project.restore_result?.archive_index;
  return index && typeof index === "object"
    ? (index as Partial<LegacyMigrationArchiveIndex>)
    : undefined;
}

function SelectiveRestoreControls({
  project,
  reload,
}: {
  project: LegacyMigrationProjectSummary;
  reload: () => Promise<void>;
}) {
  const [index, setIndex] = useState<LegacyMigrationArchiveIndex>();
  const [includePaths, setIncludePaths] = useState("");
  const [excludePaths, setExcludePaths] = useState("");
  const [working, setWorking] = useState<"" | "index" | "restore">("");
  const summary = index ?? archiveSummaryFromProject(project);
  const include = pathLines(includePaths);
  const exclude = pathLines(excludePaths);
  const hasSelection = include.length > 0 || exclude.length > 0;
  const canRestore =
    !!summary?.cache_id &&
    (project.restore_status === "indexed" ||
      project.restore_status === "failed" ||
      index != null);

  async function indexArchive() {
    setWorking("index");
    try {
      const response =
        await webapp_client.conat_client.hub.legacyMigration.prepareArchiveSelection(
          {
            legacy_project_id: project.legacy_project_id,
            max_entries: 5000,
          },
        );
      setIndex(response.index);
      void message.success("Archive indexed on the project host.");
      await reload();
    } catch (err) {
      void message.error(`${err}`);
    } finally {
      setWorking("");
    }
  }

  async function restoreSelected() {
    if (!hasSelection) return;
    setWorking("restore");
    try {
      await webapp_client.conat_client.hub.legacyMigration.restoreArchiveSelection(
        {
          legacy_project_id: project.legacy_project_id,
          include_paths: include,
          exclude_paths: exclude,
        },
      );
      void message.success("Selected files restored.");
      setIndex(undefined);
      await reload();
    } catch (err) {
      void message.error(`${err}`);
    } finally {
      setWorking("");
    }
  }

  return (
    <Space direction="vertical" size={6} style={{ maxWidth: 520 }}>
      <Button
        disabled={project.restore_status === "indexing"}
        loading={working === "index" || project.restore_status === "indexing"}
        onClick={() => void indexArchive()}
        size="small"
      >
        {summary?.cache_id ? "Refresh file list" : "Index archive"}
      </Button>
      {summary?.cache_id ? (
        <Text type="secondary">
          {summary.file_count ?? "Unknown"} entries,{" "}
          {summary.uncompressed_bytes ?? "unknown"} bytes expanded
          {summary.truncated ? " (list truncated)" : ""}
        </Text>
      ) : null}
      {index?.entries?.length ? (
        <Table<LegacyMigrationArchiveEntry>
          columns={[
            {
              title: "Path",
              dataIndex: "path",
              key: "path",
              ellipsis: true,
            },
            {
              title: "Type",
              dataIndex: "type",
              key: "type",
              width: 90,
            },
            {
              title: "Bytes",
              dataIndex: "size",
              key: "size",
              width: 100,
            },
          ]}
          dataSource={index.entries}
          pagination={{ pageSize: 8, size: "small" }}
          rowKey="path"
          size="small"
        />
      ) : null}
      {canRestore ? (
        <>
          <Input.TextArea
            autoSize={{ minRows: 2, maxRows: 5 }}
            onChange={(event) => setIncludePaths(event.target.value)}
            placeholder="Include paths, one per line. Example: src or assignments/week1"
            value={includePaths}
          />
          <Input.TextArea
            autoSize={{ minRows: 2, maxRows: 5 }}
            onChange={(event) => setExcludePaths(event.target.value)}
            placeholder="Exclude paths, one per line. Example: .conda or node_modules"
            value={excludePaths}
          />
          <Button
            disabled={!hasSelection}
            loading={
              working === "restore" || project.restore_status === "restoring"
            }
            onClick={() => void restoreSelected()}
            size="small"
            type="primary"
          >
            Restore selected files
          </Button>
        </>
      ) : null}
    </Space>
  );
}

export const LEGACY_MIGRATION_SETTINGS_PAGE = {
  component: LegacyMigrationPage,
  description: defineMessage({
    id: "account.settings.overview.legacy-migration",
    defaultMessage:
      "Import projects from legacy cocalc.com archives into CoCalc.",
  }),
  icon: "exchange",
  key: "legacy-migration",
  label: defineMessage({
    id: "account.settings.legacy-migration.label",
    defaultMessage: "Legacy migration",
  }),
  title: defineMessage({
    id: "account.settings.legacy-migration.title",
    defaultMessage: "Legacy cocalc.com migration",
  }),
} satisfies SettingsPageDefinition;

export function LegacyMigrationPage() {
  const account_id = useTypedRedux("account", "account_id");
  const legacyMigrationEnabled = !!useTypedRedux(
    "customize",
    "legacy_migration_enabled",
  );
  const legacyMigrationPageMessage = `${
    useTypedRedux("customize", "legacy_migration_page_message") ?? ""
  }`.trim();
  const [state, setState] = useState<LegacyMigrationState>({
    error: "",
    legacyAccountIds: [],
    loading: true,
    projects: [],
    totalCount: 0,
  });
  const [includeHidden, setIncludeHidden] = useState(false);
  const [maxDiskGb, setMaxDiskGb] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [pageSize, setPageSize] = useState(25);
  const [selected, setSelected] = useState<string[]>([]);
  const [importingMode, setImportingMode] = useState<
    "" | LegacyMigrationProjectRestoreMode
  >("");
  const [lastResults, setLastResults] = useState<
    LegacyMigrationImportProjectResult[]
  >([]);

  async function loadProjects(nextQuery = query) {
    if (!account_id || !legacyMigrationEnabled) return;
    setState((prev) => ({ ...prev, error: "", loading: true }));
    try {
      const response =
        await webapp_client.conat_client.hub.legacyMigration.listProjects({
          include_hidden: includeHidden,
          limit: PROJECT_LOAD_LIMIT,
          max_disk_mb: maxDiskGb == null ? undefined : maxDiskGb * 1024,
          query: nextQuery,
        });
      setState({
        error: "",
        legacyAccountIds: response.legacy_account_ids,
        loading: false,
        projects: response.projects,
        totalCount: response.total_count ?? response.projects.length,
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: `${err}`,
        loading: false,
      }));
    }
  }

  useEffect(() => {
    if (legacyMigrationEnabled) {
      void loadProjects();
    }
  }, [account_id, includeHidden, legacyMigrationEnabled]);

  async function importSelected(mode: LegacyMigrationProjectRestoreMode) {
    if (selected.length === 0) return;
    setImportingMode(mode);
    setLastResults([]);
    try {
      const response =
        await webapp_client.conat_client.hub.legacyMigration.importProjects({
          legacy_project_ids: selected,
          restore_mode: mode,
        });
      setLastResults(response.results);
      void message.info(
        resultSummary(response.results) || "No projects changed",
      );
      setSelected([]);
      await loadProjects();
    } catch (err) {
      void message.error(`${err}`);
    } finally {
      setImportingMode("");
    }
  }

  const columns = [
    {
      title: "Project",
      dataIndex: "title",
      key: "title",
      width: 520,
      render: (_: unknown, project: LegacyMigrationProjectSummary) => (
        <Space direction="vertical" size={2} style={{ width: "100%" }}>
          <Text
            strong
            ellipsis={{ tooltip: project.title }}
            style={{ display: "block", width: "100%" }}
          >
            {project.title}
          </Text>
          <Text
            type="secondary"
            style={{ display: "block", fontSize: 12, width: "100%" }}
          >
            {project.legacy_project_id}
          </Text>
          {project.description ? (
            <Text
              type="secondary"
              ellipsis={{ tooltip: project.description }}
              style={{ display: "block", width: "100%" }}
            >
              {project.description}
            </Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: "Last edited",
      dataIndex: "last_edited",
      key: "last_edited",
      width: 220,
      render: (value: Date | string | null) => formatDate(value),
      sorter: (
        left: LegacyMigrationProjectSummary,
        right: LegacyMigrationProjectSummary,
      ) =>
        new Date(left.last_edited ?? 0).getTime() -
        new Date(right.last_edited ?? 0).getTime(),
    },
    {
      title: "Size",
      dataIndex: "disk_mb",
      key: "disk_mb",
      width: 130,
      render: (value: number | null | undefined) => formatDiskMb(value),
      sorter: (
        left: LegacyMigrationProjectSummary,
        right: LegacyMigrationProjectSummary,
      ) => (left.disk_mb ?? -1) - (right.disk_mb ?? -1),
    },
    {
      title: "Import",
      key: "import",
      width: 170,
      render: (_: unknown, project: LegacyMigrationProjectSummary) => (
        <Space direction="vertical" size={4}>
          {importTag(project)}
          {projectLink(project.project_id)}
        </Space>
      ),
    },
    {
      title: "Files",
      key: "files",
      width: 280,
      render: (_: unknown, project: LegacyMigrationProjectSummary) => (
        <Space direction="vertical" size={4}>
          {restoreTag(project)}
          {project.restore_error ? (
            <Text type="danger">{project.restore_error}</Text>
          ) : null}
          {project.artifact_status && !project.restore_status ? (
            <Text type="secondary">{project.artifact_status}</Text>
          ) : null}
          {project.restore_mode === "select" &&
          project.project_id &&
          project.restore_status !== "restored" &&
          project.restore_status !== "restoring" ? (
            <SelectiveRestoreControls
              project={project}
              reload={() => loadProjects()}
            />
          ) : null}
        </Space>
      ),
    },
  ];

  if (!legacyMigrationEnabled) {
    return (
      <Alert
        showIcon
        type="info"
        message="Legacy cocalc.com migration is not enabled on this site."
        description="An administrator must enable legacy migration in site settings before this page can import archived cocalc.com projects."
      />
    );
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Paragraph type="secondary">
        Import selected projects from the archived legacy cocalc.com snapshot.
        Project metadata is created immediately. File archives are restored from
        R2 by a follow-up restore worker, so imported projects can temporarily
        show as file restore pending.
      </Paragraph>
      <Paragraph type="secondary">
        This page loads up to {PROJECT_LOAD_LIMIT.toLocaleString()} matching
        projects at a time, sorted by most recent edit. These are the projects
        available from your matched legacy account records, along with their
        current migration status. You can return later, search for older
        projects, and migrate more projects at any time.
      </Paragraph>

      {legacyMigrationPageMessage ? (
        <Alert showIcon type="info" message={legacyMigrationPageMessage} />
      ) : null}

      <Alert
        showIcon
        type="warning"
        message="Legacy migration is still being rolled out"
        description={
          <span>
            This page lists projects from legacy cocalc.com account records that
            match a verified email on your current account. Gmail addresses also
            match their Gmail dot/plus aliases. To match projects associated
            with another email address, change and verify your email in{" "}
            <a href="/settings/profile">profile settings</a>, then come back to
            this page.
          </span>
        }
      />

      {state.error ? (
        <Alert showIcon type="error" message={state.error} />
      ) : null}

      <Card
        title={
          <Space>
            <Icon name="exchange" />
            <span>cocalc.com projects</span>
          </Space>
        }
        extra={
          <Space wrap>
            <Checkbox
              checked={includeHidden}
              onChange={(event) => setIncludeHidden(event.target.checked)}
            >
              Include hidden
            </Checkbox>
            <InputNumber
              min={0}
              onChange={(value) =>
                setMaxDiskGb(
                  typeof value === "number" && Number.isFinite(value)
                    ? value
                    : null,
                )
              }
              placeholder="Max size GB"
              precision={1}
              step={1}
              style={{ width: 130 }}
              value={maxDiskGb}
            />
            <Button loading={state.loading} onClick={() => void loadProjects()}>
              Refresh
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Input.Search
            allowClear
            enterButton="Search"
            onChange={(event) => setQuery(event.target.value)}
            onSearch={(value) => {
              setQuery(value);
              void loadProjects(value);
            }}
            placeholder="Search legacy projects"
            value={query}
          />

          {state.loading && state.projects.length === 0 ? (
            <Loading />
          ) : state.legacyAccountIds.length === 0 ? (
            <Alert
              showIcon
              type="info"
              message="No linked cocalc.com account found"
              description={
                <span>
                  Use the same verified email address as your old cocalc.com
                  account. To try another address, change and verify your email
                  in <a href="/settings/profile">profile settings</a>, then
                  refresh this page. Contact support if your legacy account used
                  another identity.
                </span>
              }
            />
          ) : (
            <>
              <Space wrap>
                <Text type="secondary">
                  Matched {state.legacyAccountIds.length} legacy cocalc.com
                  account record
                  {state.legacyAccountIds.length === 1 ? "" : "s"} by verified
                  email. Showing {state.projects.length.toLocaleString()} of{" "}
                  {state.totalCount.toLocaleString()} matching project
                  {state.totalCount === 1 ? "" : "s"}.
                </Text>
                <Button
                  disabled={selected.length === 0 || !!importingMode}
                  loading={importingMode === "full"}
                  onClick={() => void importSelected("full")}
                  type="primary"
                >
                  Import selected
                </Button>
                <Button
                  disabled={selected.length === 0 || !!importingMode}
                  loading={importingMode === "select"}
                  onClick={() => void importSelected("select")}
                >
                  Import selected for file selection
                </Button>
              </Space>
              {lastResults.length > 0 ? (
                <Alert
                  showIcon
                  type={
                    lastResults.some((result) => result.status === "failed")
                      ? "warning"
                      : "success"
                  }
                  message={resultSummary(lastResults)}
                />
              ) : null}
              <Table<LegacyMigrationProjectSummary>
                columns={columns}
                dataSource={state.projects}
                loading={state.loading}
                scroll={{ x: 1320 }}
                tableLayout="fixed"
                pagination={{
                  pageSize,
                  showSizeChanger: true,
                  showTotal: (total, range) =>
                    `${range[0]}-${range[1]} of ${total.toLocaleString()} loaded`,
                  total: state.projects.length,
                  onChange: (_page, size) => setPageSize(size),
                  onShowSizeChange: (_page, size) => setPageSize(size),
                }}
                rowKey="legacy_project_id"
                rowSelection={{
                  selectedRowKeys: selected,
                  onChange: (keys) => setSelected(keys.map((key) => `${key}`)),
                  getCheckboxProps: (project) => ({
                    disabled: project.import_status === "creating",
                  }),
                }}
              />
            </>
          )}
        </Space>
      </Card>
    </Space>
  );
}
