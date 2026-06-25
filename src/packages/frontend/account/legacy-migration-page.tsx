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
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { defineMessage } from "react-intl";

import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, Loading } from "@cocalc/frontend/components";
import { SelectNewHost } from "@cocalc/frontend/hosts/select-new-host";
import { isNewProjectRootfsSelectable } from "@cocalc/frontend/projects/create-project-rootfs";
import { useProjectCreateDraft } from "@cocalc/frontend/projects/create/use-project-create-draft";
import {
  latestRootfsVersionEntries,
  renderRootfsCatalogOption,
} from "@cocalc/frontend/rootfs/catalog-ui";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { R2_REGION_LABELS } from "@cocalc/util/consts";
import { OTHER_SETTINGS_LEGACY_MIGRATION_PROJECTS_BUTTON } from "@cocalc/util/legacy-migration";
import type {
  LegacyMigrationArchiveEntry,
  LegacyMigrationArchiveIndex,
  LegacyMigrationMatchedAccount,
  LegacyMigrationProjectSummary,
} from "@cocalc/conat/hub/api/legacy-migration";
import type { SettingsPageDefinition } from "./settings-page";

const { Paragraph, Text } = Typography;

type LegacyMigrationState = {
  error: string;
  legacyAccounts: LegacyMigrationMatchedAccount[];
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

function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "Unknown";
  if (value < 1024) return `${Math.round(value).toLocaleString()} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let scaled = value / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && scaled >= 1024; i += 1) {
    scaled /= 1024;
    unit = units[i];
  }
  return `${scaled.toFixed(scaled < 10 ? 1 : 0)} ${unit}`;
}

function matchedAccountLabel(account: LegacyMigrationMatchedAccount): string {
  const email = `${account.email_address ?? ""}`.trim();
  if (email) return email;
  return `legacy account ${account.legacy_account_id}`;
}

function matchedAccountTitle(account: LegacyMigrationMatchedAccount): string {
  const parts = [
    `Legacy account: ${account.legacy_account_id}`,
    account.match_method
      ? `Match method: ${account.match_method.replace(/-/g, " ")}`
      : "",
    account.gmail_canonical_email
      ? `Gmail canonical: ${account.gmail_canonical_email}`
      : "",
  ].filter(Boolean);
  return parts.join("\n");
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

function restoreProgressText(
  progress: LegacyMigrationProjectSummary["restore_progress"],
): string {
  if (!progress || typeof progress !== "object") return "";
  const phase = `${progress.phase ?? ""}`.trim();
  const detail = `${progress.message ?? ""}`.trim();
  return [phase, detail].filter(Boolean).join(": ");
}

function restoreProgressPercent(
  progress: LegacyMigrationProjectSummary["restore_progress"],
): number | undefined {
  const value = progress?.progress;
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  return Math.max(0, Math.min(100, Math.round(value)));
}

async function openProject(project_id: string): Promise<void> {
  try {
    await (
      redux.getActions("projects") as any
    )?.ensureRealtimeFeedForCurrentAccount?.();
    await redux.getActions("projects").open_project({
      project_id,
      target: "files",
      switch_to: true,
      restore_session: false,
    });
  } catch (err) {
    void message.error(`${err}`);
  }
}

function archiveAvailable(project: LegacyMigrationProjectSummary): boolean {
  return project.artifact_status === "available" && !!project.artifact_key;
}

function ignoreProjectRowClick(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  return !!element?.closest(
    [
      "a",
      "button",
      "input",
      "textarea",
      ".ant-checkbox-wrapper",
      ".ant-input-number",
      ".ant-pagination",
      ".ant-select",
      ".ant-switch",
      ".ant-table-filter-trigger",
    ].join(","),
  );
}

function LegacyProjectImportModal({
  project,
  open,
  onClose,
  onImported,
}: {
  project?: LegacyMigrationProjectSummary;
  open: boolean;
  onClose: () => void;
  onImported: (
    project: LegacyMigrationProjectSummary,
    project_id: string,
  ) => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const lastResetProjectRef = useRef<string | undefined>(undefined);
  const {
    draft,
    summary,
    rootfsImages,
    rootfsLoading,
    rootfsError,
    isAdmin,
    selectedHost,
    setHost,
    setRootfs,
    reset,
  } = useProjectCreateDraft({
    defaultValue: project?.title ?? "",
  });
  const selectableRootfsImages = useMemo(
    () =>
      latestRootfsVersionEntries(
        rootfsImages.filter((entry) =>
          isNewProjectRootfsSelectable({
            entry,
            isGpu: summary.gpu,
            isAdmin,
          }),
        ),
        { preserveIds: [draft.rootfs_image_id] },
      ),
    [draft.rootfs_image_id, isAdmin, rootfsImages, summary.gpu],
  );

  useEffect(() => {
    const legacyProjectId = open ? project?.legacy_project_id : undefined;
    if (!legacyProjectId) {
      lastResetProjectRef.current = undefined;
      return;
    }
    if (lastResetProjectRef.current === legacyProjectId) return;
    lastResetProjectRef.current = legacyProjectId;
    reset();
    setError("");
    setImporting(false);
  }, [open, project?.legacy_project_id, reset]);

  async function importAndOpen() {
    if (!project) return;
    if (!archiveAvailable(project)) {
      setError(
        "The archived files for this legacy project are not available yet.",
      );
      return;
    }
    if (!draft.rootfs_image.trim()) {
      setError("Choose an image before importing this project.");
      return;
    }
    setImporting(true);
    setError("");
    try {
      const response =
        await webapp_client.conat_client.hub.legacyMigration.importProjects({
          legacy_project_ids: [project.legacy_project_id],
          restore_mode: "full",
          rootfs_image: draft.rootfs_image,
          rootfs_image_id: draft.rootfs_image_id,
          host_id: draft.host_id,
          region: draft.region,
        });
      const result = response.results[0];
      if (!result?.project_id || result.status === "failed") {
        throw new Error(result?.error ?? "Legacy project import failed.");
      }
      await onImported(project, result.project_id);
      onClose();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setImporting(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Import legacy project"
      onCancel={onClose}
      width="min(900px, 96vw)"
      okText="Import and Open"
      confirmLoading={importing}
      onOk={() => void importAndOpen()}
      okButtonProps={{
        disabled:
          !project ||
          !archiveAvailable(project) ||
          rootfsLoading ||
          !draft.rootfs_image.trim(),
      }}
      destroyOnHidden
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {project ? (
          <Alert
            showIcon
            type={archiveAvailable(project) ? "info" : "error"}
            message={project.title}
            description={
              archiveAvailable(project)
                ? `This will create a CoCalc project, open it immediately, and restore files from the legacy archive in the background. Last known disk use: ${formatDiskMb(project.disk_mb)}. Archived size: ${formatBytes(project.artifact_bytes)}.`
                : "The archived files for this project are not available yet, so it cannot be imported without creating a blank project."
            }
          />
        ) : null}
        {error ? <Alert showIcon type="error" message={error} /> : null}
        {rootfsError ? (
          <Alert
            showIcon
            type="warning"
            message={`Image catalog load issue: ${rootfsError}`}
          />
        ) : null}
        <Space direction="vertical" size={6} style={{ width: "100%" }}>
          <Text strong>Image</Text>
          <Select
            showSearch
            loading={rootfsLoading}
            disabled={importing || rootfsLoading}
            value={draft.rootfs_image_id ?? draft.rootfs_image}
            optionFilterProp="data-search"
            style={{ width: "100%" }}
            popupMatchSelectWidth={false}
            onChange={(value) => {
              const entry = selectableRootfsImages.find(
                (entry) => (entry.id ?? entry.image) === value,
              );
              if (entry) {
                setRootfs({ image: entry.image, image_id: entry.id });
              }
            }}
          >
            {selectableRootfsImages.map((entry) => (
              <Select.Option
                key={entry.id ?? entry.image}
                value={entry.id ?? entry.image}
                data-search={[
                  entry.label,
                  entry.image,
                  entry.description,
                  entry.theme?.title,
                  entry.theme?.description,
                  ...(entry.tags ?? []),
                ]
                  .filter(Boolean)
                  .join(" ")
                  .toLowerCase()}
              >
                {renderRootfsCatalogOption(entry)}
              </Select.Option>
            ))}
          </Select>
        </Space>
        <SelectNewHost
          disabled={importing}
          selectedHost={selectedHost}
          onChange={setHost}
          regionFilter={draft.region}
          regionLabel={R2_REGION_LABELS[draft.region]}
          wantsGpu={summary.gpu}
          pickerMode="create"
          pickerDisplay="modal"
          showHelp={false}
        />
      </Space>
    </Modal>
  );
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
  const otherSettings = useTypedRedux("account", "other_settings");
  const showLegacyProjectsButton = !!otherSettings?.get(
    OTHER_SETTINGS_LEGACY_MIGRATION_PROJECTS_BUTTON,
  );
  const [state, setState] = useState<LegacyMigrationState>({
    error: "",
    legacyAccounts: [],
    legacyAccountIds: [],
    loading: true,
    projects: [],
    totalCount: 0,
  });
  const [includeHidden, setIncludeHidden] = useState(false);
  const [maxDiskGb, setMaxDiskGb] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [pageSize, setPageSize] = useState(25);
  const [importProject, setImportProject] =
    useState<LegacyMigrationProjectSummary>();
  const [openingLegacyProjectId, setOpeningLegacyProjectId] = useState("");

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
        legacyAccounts: response.legacy_accounts ?? [],
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

  function setShowLegacyProjectsButton(show: boolean): void {
    redux
      .getActions("account")
      .set_other_settings(
        OTHER_SETTINGS_LEGACY_MIGRATION_PROJECTS_BUTTON,
        show,
      );
    void message.success(
      show
        ? "Legacy Projects button enabled on the Projects page."
        : "Legacy Projects button hidden from the Projects page.",
    );
  }

  async function openImportedProject(
    project: LegacyMigrationProjectSummary,
    project_id: string,
  ): Promise<void> {
    if (project.restore_status !== "restored") {
      void message.info(
        "Opening project now. CoCalc will restore the legacy files in the background.",
      );
    }
    await openProject(project_id);
    await loadProjects();
  }

  async function handleProjectAction(
    project: LegacyMigrationProjectSummary,
  ): Promise<void> {
    if (project.project_id) {
      if (project.joined) {
        setOpeningLegacyProjectId(project.legacy_project_id);
        try {
          await openImportedProject(project, project.project_id);
        } catch (err) {
          void message.error(`${err}`);
        } finally {
          setOpeningLegacyProjectId("");
        }
        return;
      }
      setOpeningLegacyProjectId(project.legacy_project_id);
      try {
        const response =
          await webapp_client.conat_client.hub.legacyMigration.importProjects({
            legacy_project_ids: [project.legacy_project_id],
            restore_mode: "full",
          });
        const result = response.results[0];
        if (!result?.project_id || result.status === "failed") {
          throw new Error(result?.error ?? "Unable to join legacy project.");
        }
        await openImportedProject(project, result.project_id);
      } catch (err) {
        void message.error(`${err}`);
      } finally {
        setOpeningLegacyProjectId("");
      }
      return;
    }
    if (!archiveAvailable(project)) {
      void message.error(
        "The archived files for this legacy project are not available yet.",
      );
      return;
    }
    setImportProject(project);
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
      title: "Disk size",
      dataIndex: "disk_mb",
      key: "disk_mb",
      width: 130,
      render: (value: number | null | undefined) => (
        <Space direction="vertical" size={0}>
          <Text>{formatDiskMb(value)}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            last known
          </Text>
        </Space>
      ),
      sorter: (
        left: LegacyMigrationProjectSummary,
        right: LegacyMigrationProjectSummary,
      ) => (left.disk_mb ?? -1) - (right.disk_mb ?? -1),
    },
    {
      title: "Archived size",
      dataIndex: "artifact_bytes",
      key: "artifact_bytes",
      width: 150,
      render: (value: number | null | undefined) => (
        <Space direction="vertical" size={0}>
          <Text>{formatBytes(value)}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            compressed tar.zst
          </Text>
        </Space>
      ),
      sorter: (
        left: LegacyMigrationProjectSummary,
        right: LegacyMigrationProjectSummary,
      ) => (left.artifact_bytes ?? -1) - (right.artifact_bytes ?? -1),
    },
    {
      title: "Open",
      key: "import",
      width: 170,
      render: (_: unknown, project: LegacyMigrationProjectSummary) => (
        <Space direction="vertical" size={4}>
          {importTag(project)}
          <Button
            loading={
              project.import_status === "creating" ||
              openingLegacyProjectId === project.legacy_project_id
            }
            onClick={() => void handleProjectAction(project)}
            size="small"
          >
            {project.project_id ? "Open" : "Import and Open"}
          </Button>
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
          {restoreProgressText(project.restore_progress) ? (
            <Text type="secondary">
              {restoreProgressText(project.restore_progress)}
              {restoreProgressPercent(project.restore_progress) != null
                ? ` (${restoreProgressPercent(project.restore_progress)}%)`
                : ""}
            </Text>
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
        Open projects from the archived legacy cocalc.com snapshot. Already
        imported projects open immediately. For projects that have not been
        imported yet, choose an image and host, then CoCalc creates the project
        and restores its files from the archive.
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

      <Card size="small">
        <Space direction="vertical" size={4}>
          <Space>
            <Switch
              checked={showLegacyProjectsButton}
              onChange={setShowLegacyProjectsButton}
            />
            <Text strong>Show Legacy Projects button on the Projects page</Text>
          </Space>
          <Text type="secondary">
            When enabled, the Projects page shows a Legacy Projects button that
            opens this migration page without a browser refresh.
          </Text>
        </Space>
      </Card>

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
              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                <Text type="secondary">
                  Matched {state.legacyAccountIds.length} legacy cocalc.com
                  account record
                  {state.legacyAccountIds.length === 1 ? "" : "s"} by verified
                  email:
                </Text>
                <Space wrap size={[4, 4]}>
                  {(state.legacyAccounts.length > 0
                    ? state.legacyAccounts
                    : state.legacyAccountIds.map((legacy_account_id) => ({
                        legacy_account_id,
                      }))
                  ).map((account) => (
                    <Tag
                      key={account.legacy_account_id}
                      title={matchedAccountTitle(account)}
                    >
                      {matchedAccountLabel(account)}
                    </Tag>
                  ))}
                </Space>
                <Text type="secondary">
                  If you want to also include projects associated with a
                  different email address, change your email address in{" "}
                  <a href="/settings/profile">profile settings</a>, verify it,
                  then come back to this page.
                </Text>
                <Text type="secondary">
                  Showing the{" "}
                  {state.projects.length === state.totalCount
                    ? ""
                    : "most recently edited "}
                  {state.projects.length.toLocaleString()} of{" "}
                  {state.totalCount.toLocaleString()} available matching project
                  {state.totalCount === 1 ? "" : "s"}. You can migrate projects
                  in multiple sessions; use search, hidden-projects, or size
                  filters to find projects outside this loaded list.
                </Text>
              </Space>
              <Table<LegacyMigrationProjectSummary>
                columns={columns}
                dataSource={state.projects}
                loading={state.loading}
                scroll={{ x: 1470 }}
                tableLayout="fixed"
                onRow={(project) => ({
                  onClick: (event) => {
                    if (ignoreProjectRowClick(event.target)) return;
                    void handleProjectAction(project);
                  },
                  style: { cursor: "pointer" },
                })}
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
              />
              <LegacyProjectImportModal
                project={importProject}
                open={importProject != null}
                onClose={() => setImportProject(undefined)}
                onImported={openImportedProject}
              />
            </>
          )}
        </Space>
      </Card>
    </Space>
  );
}
