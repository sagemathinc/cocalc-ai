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
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Key,
  type ReactNode,
} from "react";
import { defineMessage } from "react-intl";

import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, Loading } from "@cocalc/frontend/components";
import { load_target } from "@cocalc/frontend/history";
import { SelectNewHost } from "@cocalc/frontend/hosts/select-new-host";
import { markLegacyProjectRestoreKnownRestored } from "@cocalc/frontend/project/legacy-migration-restore-banner";
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
  LegacyMigrationImportProjectResult,
  LegacyMigrationMatchedAccount,
  LegacyMigrationProjectSummary,
} from "@cocalc/conat/hub/api/legacy-migration";
import type { SettingsPageDefinition } from "./settings-page";

const { Text } = Typography;

function InternalRouteLink({
  children,
  href,
  target,
}: {
  children: ReactNode;
  href: string;
  target: string;
}) {
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        load_target(target);
      }}
    >
      {children}
    </a>
  );
}

type LegacyMigrationState = {
  error: string;
  emailVerificationEmail?: string | null;
  emailVerificationRequired: boolean;
  legacyAccounts: LegacyMigrationMatchedAccount[];
  legacyAccountIds: string[];
  loading: boolean;
  projects: LegacyMigrationProjectSummary[];
  totalCount: number;
  unverifiedEmailMatches: LegacyMigrationMatchedAccount[];
};

// Keep in sync with src/packages/server/legacy-migration/index.ts.
// This is one-off migration code, so duplicating the small constant is simpler
// than introducing a shared frontend/backend package dependency.
const MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST = 50;
const PROJECT_LOAD_LIMIT = 1000;
type LegacyProjectStatusFilter =
  | "all"
  | "ready"
  | "restoring"
  | "restored"
  | "not-available"
  | "failed";

function formatDate(value?: Date | string | null): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "Unknown";
  return date.toLocaleString();
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

function restoreProgressText(
  progress: LegacyMigrationProjectSummary["restore_progress"],
): string {
  if (!progress || typeof progress !== "object") return "";
  const phase = `${progress.phase ?? ""}`.trim();
  const detail = `${progress.message ?? ""}`.trim();
  const parts = [[phase, detail].filter(Boolean).join(": ")].filter(Boolean);
  const progressDetail = progress.detail;
  if (progressDetail && typeof progressDetail === "object") {
    const skippedCount = (progressDetail as any).skipped_file_count;
    const skippedBytes = formatBytes((progressDetail as any).skipped_bytes);
    if (
      typeof skippedCount === "number" &&
      Number.isFinite(skippedCount) &&
      skippedCount > 0
    ) {
      parts.push(
        skippedBytes
          ? `${skippedCount.toLocaleString()} oversized file(s) skipped (${skippedBytes})`
          : `${skippedCount.toLocaleString()} oversized file(s) skipped`,
      );
    }
  }
  return parts.join(" • ");
}

function projectStatusFilter(
  project: LegacyMigrationProjectSummary,
): Exclude<LegacyProjectStatusFilter, "all"> {
  if (
    project.import_status === "failed" ||
    project.restore_status === "failed"
  ) {
    return "failed";
  }
  if (
    project.import_status === "creating" ||
    project.restore_status === "pending" ||
    project.restore_status === "restoring" ||
    project.restore_status === "indexing"
  ) {
    return "restoring";
  }
  if (project.restore_status === "restored") return "restored";
  if (!archiveAvailable(project) && !project.project_id) {
    return "not-available";
  }
  return "ready";
}

function projectStatusTag(project: LegacyMigrationProjectSummary) {
  const status = projectStatusFilter(project);
  if (status === "restored") return <Tag color="green">Restored</Tag>;
  if (status === "restoring") return <Tag color="blue">Restoring</Tag>;
  if (status === "failed") return <Tag color="red">Failed</Tag>;
  if (status === "not-available") return <Tag>Not yet available</Tag>;
  if (project.project_id) return <Tag color="green">Imported</Tag>;
  return <Tag color="gold">Ready to restore</Tag>;
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
  return (
    project.artifact_status === "available" &&
    !!project.artifact_key &&
    typeof project.artifact_bytes === "number" &&
    Number.isFinite(project.artifact_bytes)
  );
}

function projectActionAvailable(
  project: LegacyMigrationProjectSummary,
): boolean {
  return !!project.project_id || archiveAvailable(project);
}

function bulkRestoreSelectable(
  project: LegacyMigrationProjectSummary,
): boolean {
  return (
    !project.project_id &&
    project.import_status !== "creating" &&
    archiveAvailable(project)
  );
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

function LegacyProjectBulkImportModal({
  projects,
  open,
  onClose,
  onImported,
}: {
  projects: LegacyMigrationProjectSummary[];
  open: boolean;
  onClose: () => void;
  onImported: (results: LegacyMigrationImportProjectResult[]) => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const lastResetKeyRef = useRef<string | undefined>(undefined);
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
    defaultValue: "Legacy projects",
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
  const hasDiskEstimate = projects.some((project) => project.disk_mb != null);
  const lastKnownDiskMb = hasDiskEstimate
    ? projects.reduce((total, project) => total + (project.disk_mb ?? 0), 0)
    : undefined;
  const archivedBytes = projects.reduce(
    (total, project) => total + (project.artifact_bytes ?? 0),
    0,
  );

  useEffect(() => {
    const key = open
      ? projects.map((project) => project.legacy_project_id).join(",")
      : undefined;
    if (!key) {
      lastResetKeyRef.current = undefined;
      return;
    }
    if (lastResetKeyRef.current === key) return;
    lastResetKeyRef.current = key;
    reset();
    setError("");
    setImporting(false);
  }, [open, projects, reset]);

  async function importSelected() {
    if (projects.length === 0) {
      setError("Select one or more ready legacy projects first.");
      return;
    }
    if (projects.length > MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST) {
      setError(
        `Restore at most ${MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST} legacy projects at a time. Restore this batch, then select the next batch.`,
      );
      return;
    }
    if (!draft.rootfs_image.trim()) {
      setError("Choose an image before restoring selected projects.");
      return;
    }
    setImporting(true);
    setError("");
    try {
      const response =
        await webapp_client.conat_client.hub.legacyMigration.importProjects({
          legacy_project_ids: projects.map(
            (project) => project.legacy_project_id,
          ),
          restore_mode: "full",
          rootfs_image: draft.rootfs_image,
          rootfs_image_id: draft.rootfs_image_id,
          host_id: draft.host_id,
          region: draft.region,
        });
      await onImported(response.results);
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
      title="Restore selected legacy projects"
      onCancel={onClose}
      width="min(900px, 96vw)"
      okText="Restore selected"
      confirmLoading={importing}
      onOk={() => void importSelected()}
      okButtonProps={{
        disabled:
          projects.length === 0 || rootfsLoading || !draft.rootfs_image.trim(),
      }}
      destroyOnHidden
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Alert
          showIcon
          type="info"
          message={`Restore ${projects.length.toLocaleString()} selected legacy project${
            projects.length === 1 ? "" : "s"
          }`}
          description={`CoCalc will create these projects using the same image and host, then restore their files in the background. Restore at most ${MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST} projects per batch. Last known disk use: ${formatDiskMb(lastKnownDiskMb)}. Archived size: ${formatBytes(archivedBytes)}.`}
        />
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
    defaultMessage: "Legacy Projects",
  }),
  title: defineMessage({
    id: "account.settings.legacy-migration.title",
    defaultMessage: "Legacy cocalc.com migration",
  }),
} satisfies SettingsPageDefinition;

export function LegacyMigrationPage() {
  const account_id = useTypedRedux("account", "account_id");
  const emailAddress =
    `${useTypedRedux("account", "email_address") ?? ""}`.trim();
  const emailAddressVerified = useTypedRedux(
    "account",
    "email_address_verified",
  );
  const primaryEmailVerified =
    !!emailAddress && !!emailAddressVerified?.get(emailAddress);
  const verifyEmailsEnabled = !!useTypedRedux("customize", "verify_emails");
  const emailVerificationRequired =
    verifyEmailsEnabled && !primaryEmailVerified;
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
    emailVerificationEmail: null,
    emailVerificationRequired: false,
    legacyAccounts: [],
    legacyAccountIds: [],
    loading: true,
    projects: [],
    totalCount: 0,
    unverifiedEmailMatches: [],
  });
  const [includeHidden, setIncludeHidden] = useState(false);
  const [includeNotAvailable, setIncludeNotAvailable] = useState(false);
  const [maxDiskGb, setMaxDiskGb] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<LegacyProjectStatusFilter>("all");
  const [pageSize, setPageSize] = useState(25);
  const [importProject, setImportProject] =
    useState<LegacyMigrationProjectSummary>();
  const [openingLegacyProjectId, setOpeningLegacyProjectId] = useState("");
  const [selectedLegacyProjectIds, setSelectedLegacyProjectIds] = useState<
    string[]
  >([]);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [bulkResults, setBulkResults] = useState<
    LegacyMigrationImportProjectResult[]
  >([]);

  async function loadProjects(nextQuery = query) {
    if (!account_id || !legacyMigrationEnabled) return;
    setState((prev) => ({ ...prev, error: "", loading: true }));
    try {
      const response =
        await webapp_client.conat_client.hub.legacyMigration.listProjects({
          include_hidden: includeHidden,
          include_not_available: includeNotAvailable,
          limit: PROJECT_LOAD_LIMIT,
          max_disk_mb: maxDiskGb == null ? undefined : maxDiskGb * 1024,
          query: nextQuery,
        });
      setState({
        error: "",
        emailVerificationEmail: response.email_verification_email ?? null,
        emailVerificationRequired: !!response.email_verification_required,
        legacyAccounts: response.legacy_accounts ?? [],
        legacyAccountIds: response.legacy_account_ids,
        loading: false,
        projects: response.projects,
        totalCount: response.total_count ?? response.projects.length,
        unverifiedEmailMatches: response.unverified_email_matches ?? [],
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
  }, [account_id, includeHidden, includeNotAvailable, legacyMigrationEnabled]);

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
    if (project.restore_status === "restored") {
      markLegacyProjectRestoreKnownRestored({
        project_id,
        opId: project.restore_lro_op_id,
      });
    }
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
    if (!projectActionAvailable(project)) {
      return;
    }
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

  const projectStats = useMemo(() => {
    const stats: Record<Exclude<LegacyProjectStatusFilter, "all">, number> = {
      failed: 0,
      ready: 0,
      restored: 0,
      restoring: 0,
      "not-available": 0,
    };
    for (const project of state.projects) {
      stats[projectStatusFilter(project)] += 1;
    }
    return stats;
  }, [state.projects]);

  const filteredProjects = useMemo(() => {
    if (statusFilter === "all") return state.projects;
    return state.projects.filter(
      (project) => projectStatusFilter(project) === statusFilter,
    );
  }, [state.projects, statusFilter]);

  const selectedProjects = useMemo(() => {
    const ids = new Set(selectedLegacyProjectIds);
    return filteredProjects.filter(
      (project) =>
        ids.has(project.legacy_project_id) && bulkRestoreSelectable(project),
    );
  }, [filteredProjects, selectedLegacyProjectIds]);
  const selectedProjectCountAtLimit =
    selectedProjects.length >= MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST;

  function setSelectedLegacyProjectKeys(keys: Key[]): void {
    const next = keys.map((key) => `${key}`);
    if (next.length > MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST) {
      void message.warning(
        `You can restore at most ${MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST} legacy projects at a time. CoCalc selected the first ${MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST}; restore this batch, then select the next batch.`,
      );
      setSelectedLegacyProjectIds(
        next.slice(0, MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST),
      );
      return;
    }
    setSelectedLegacyProjectIds(next);
  }

  async function handleBulkImported(
    results: LegacyMigrationImportProjectResult[],
  ): Promise<void> {
    setBulkResults(results);
    setSelectedLegacyProjectIds([]);
    await loadProjects();
    const failed = results.filter((result) => result.status === "failed");
    if (failed.length > 0) {
      void message.warning(
        `${failed.length.toLocaleString()} of ${results.length.toLocaleString()} selected restore request${
          results.length === 1 ? "" : "s"
        } failed.`,
      );
    } else {
      void message.success(
        `Started ${results.length.toLocaleString()} legacy project restore${
          results.length === 1 ? "" : "s"
        }.`,
      );
    }
  }

  function openBulkImportModal(): void {
    if (selectedProjects.length === 0) {
      void message.info(
        "Select one or more ready, not-yet-restored projects first.",
      );
      return;
    }
    if (selectedProjects.length > MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST) {
      setSelectedLegacyProjectIds((ids) =>
        ids.slice(0, MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST),
      );
      void message.warning(
        `Restore at most ${MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST} projects at a time.`,
      );
      return;
    }
    setBulkResults([]);
    setBulkImportOpen(true);
  }

  const columns = [
    {
      title: "Project",
      dataIndex: "title",
      key: "title",
      width: 560,
      render: (_: unknown, project: LegacyMigrationProjectSummary) => (
        <Space direction="vertical" size={2} style={{ width: "100%" }}>
          <Text
            strong
            ellipsis={{ tooltip: project.title }}
            style={{ display: "block", width: "100%" }}
          >
            {project.title}
          </Text>
          <span onClick={(event) => event.stopPropagation()}>
            <Text
              copyable={{ text: project.legacy_project_id }}
              type="secondary"
              style={{ display: "block", fontSize: 12, width: "100%" }}
            >
              {project.legacy_project_id}
            </Text>
          </span>
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
      title: "Status",
      key: "status",
      width: 180,
      render: (_: unknown, project: LegacyMigrationProjectSummary) => (
        <Space direction="vertical" size={4}>
          {projectStatusTag(project)}
          {project.restore_error ? (
            <Text type="danger" ellipsis={{ tooltip: project.restore_error }}>
              {project.restore_error}
            </Text>
          ) : null}
          {restoreProgressText(project.restore_progress) ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {restoreProgressText(project.restore_progress)}
              {restoreProgressPercent(project.restore_progress) != null
                ? ` (${restoreProgressPercent(project.restore_progress)}%)`
                : ""}
            </Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: "Last edited",
      dataIndex: "last_edited",
      key: "last_edited",
      width: 180,
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
      width: 125,
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
      width: 135,
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
      title: "Action",
      key: "import",
      width: 160,
      render: (_: unknown, project: LegacyMigrationProjectSummary) => (
        <Button
          disabled={!projectActionAvailable(project)}
          loading={
            project.import_status === "creating" ||
            openingLegacyProjectId === project.legacy_project_id
          }
          onClick={() => void handleProjectAction(project)}
          size="small"
          title={
            projectActionAvailable(project)
              ? undefined
              : "Archived files for this legacy project are not available yet."
          }
          type={project.project_id ? "default" : "primary"}
        >
          {project.project_id
            ? "Open"
            : archiveAvailable(project)
              ? "Restore and Open"
              : "Unavailable"}
        </Button>
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

  const verificationEmail = state.emailVerificationEmail || emailAddress;
  const showEmailVerificationRequired =
    emailVerificationRequired || state.emailVerificationRequired;
  const emailVerificationPrompt = (
    <span>
      {verificationEmail ? (
        <>
          Your current email address <Text code>{verificationEmail}</Text> is
          not verified.
        </>
      ) : (
        <>Your account does not have an email address set.</>
      )}{" "}
      Legacy projects are matched by verified email address. Open{" "}
      <InternalRouteLink href="/settings/profile" target="settings/profile">
        profile settings
      </InternalRouteLink>{" "}
      to{" "}
      {verificationEmail
        ? "verify this email address"
        : "set and verify an email address"}
      , then return to this page and refresh.
      {state.unverifiedEmailMatches.length > 0 ? (
        <>
          {" "}
          CoCalc found matching legacy cocalc.com account data for this email.
        </>
      ) : null}
    </span>
  );

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      {showEmailVerificationRequired ? (
        <Alert
          showIcon
          type="warning"
          message="Verify your email address to find legacy projects"
          description={emailVerificationPrompt}
        />
      ) : null}
      <Card size="small">
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Space align="start" style={{ width: "100%" }}>
            <Icon name="exchange" style={{ fontSize: 22, marginTop: 2 }} />
            <Space direction="vertical" size={2} style={{ flex: 1 }}>
              <Text strong style={{ fontSize: 18 }}>
                Legacy Projects
              </Text>
              <Text type="secondary">
                Open a legacy project to restore its files. Large projects may
                take a few minutes; projects marked <Tag>Not yet available</Tag>{" "}
                are known to the migration system but their archive has not been
                uploaded yet.
              </Text>
              <Text type="secondary">
                Billing credit and legacy memberships are handled in{" "}
                <InternalRouteLink
                  href="/settings/balance"
                  target="settings/balance"
                >
                  Billing
                </InternalRouteLink>
                .
              </Text>
            </Space>
            <Space direction="vertical" size={4}>
              <Space>
                <Switch
                  checked={showLegacyProjectsButton}
                  onChange={setShowLegacyProjectsButton}
                  size="small"
                />
                <Text type="secondary">Show Projects-page button</Text>
              </Space>
            </Space>
          </Space>
          {legacyMigrationPageMessage ? (
            <Alert showIcon type="info" message={legacyMigrationPageMessage} />
          ) : null}
          {!emailVerificationRequired ? (
            <Space wrap size={[8, 8]}>
              <Tag color="blue">
                {state.totalCount.toLocaleString()} matching projects
              </Tag>
              <Tag color="gold">{projectStats.ready} ready</Tag>
              <Tag color="green">{projectStats.restored} restored</Tag>
              <Tag>{projectStats["not-available"]} not yet available</Tag>
              {projectStats.restoring ? (
                <Tag color="blue">{projectStats.restoring} restoring</Tag>
              ) : null}
              {projectStats.failed ? (
                <Tag color="red">{projectStats.failed} failed</Tag>
              ) : null}
            </Space>
          ) : null}
        </Space>
      </Card>

      {state.error ? (
        <Alert showIcon type="error" message={state.error} />
      ) : null}

      <Card
        title={
          <Space>
            <Icon name="exchange" />
            <span>Projects</span>
          </Space>
        }
        extra={
          <Space wrap>
            <Button
              disabled={selectedProjects.length === 0}
              onClick={openBulkImportModal}
              type="primary"
            >
              Restore selected ({selectedProjects.length.toLocaleString()})
            </Button>
            <Select
              onChange={setStatusFilter}
              style={{ width: 170 }}
              value={statusFilter}
            >
              <Select.Option value="all">All statuses</Select.Option>
              <Select.Option value="ready">Ready to restore</Select.Option>
              <Select.Option value="restoring">Restoring</Select.Option>
              <Select.Option value="restored">Restored</Select.Option>
              <Select.Option value="not-available">
                Not yet available
              </Select.Option>
              <Select.Option value="failed">Failed</Select.Option>
            </Select>
            <Checkbox
              checked={includeHidden}
              onChange={(event) => setIncludeHidden(event.target.checked)}
            >
              Include hidden
            </Checkbox>
            <Checkbox
              checked={includeNotAvailable}
              onChange={(event) => setIncludeNotAvailable(event.target.checked)}
            >
              Include not yet available
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
          ) : showEmailVerificationRequired ? (
            <Alert
              showIcon
              type="warning"
              message="Email verification required"
              description={emailVerificationPrompt}
            />
          ) : state.legacyAccountIds.length === 0 ? (
            <Alert
              showIcon
              type="info"
              message="No linked cocalc.com account found"
              description={
                <span>
                  Use the same verified email address as your old cocalc.com
                  account. To try another address, change and verify your email
                  in{" "}
                  <InternalRouteLink
                    href="/settings/profile"
                    target="settings/profile"
                  >
                    profile settings
                  </InternalRouteLink>
                  , then refresh this page. Contact support if your legacy
                  account used another identity.
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
                  <InternalRouteLink
                    href="/settings/profile"
                    target="settings/profile"
                  >
                    profile settings
                  </InternalRouteLink>
                  , verify it, then come back to this page.
                </Text>
                <Text type="secondary">
                  Showing the{" "}
                  {state.projects.length === state.totalCount
                    ? ""
                    : "most recently edited "}
                  {state.projects.length.toLocaleString()} of{" "}
                  {state.totalCount.toLocaleString()} matching legacy project
                  {state.totalCount === 1 ? "" : "s"}. You can migrate projects
                  in multiple sessions; use search, hidden-projects, or size
                  filters to find projects outside this loaded list.
                </Text>
              </Space>
              {bulkResults.length > 0 ? (
                <Alert
                  showIcon
                  type={
                    bulkResults.some((result) => result.status === "failed")
                      ? "warning"
                      : "success"
                  }
                  message={`Bulk restore results: ${bulkResults
                    .filter((result) => result.status !== "failed")
                    .length.toLocaleString()} queued, ${bulkResults
                    .filter((result) => result.status === "failed")
                    .length.toLocaleString()} failed`}
                  description={
                    <Space direction="vertical" size={2}>
                      {bulkResults.slice(0, 20).map((result) => (
                        <Text
                          key={result.legacy_project_id}
                          type={
                            result.status === "failed" ? "danger" : "secondary"
                          }
                        >
                          {result.legacy_project_id}: {result.status}
                          {result.error ? ` - ${result.error}` : ""}
                        </Text>
                      ))}
                      {bulkResults.length > 20 ? (
                        <Text type="secondary">
                          Showing first 20 of{" "}
                          {bulkResults.length.toLocaleString()} results.
                        </Text>
                      ) : null}
                    </Space>
                  }
                />
              ) : null}
              {selectedProjectCountAtLimit ? (
                <Alert
                  showIcon
                  type="warning"
                  message={`Restore at most ${MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST} projects per batch`}
                  description="Restore the selected batch first, then select the next batch of legacy projects."
                />
              ) : null}
              <Table<LegacyMigrationProjectSummary>
                columns={columns}
                dataSource={filteredProjects}
                loading={state.loading}
                scroll={{ x: 1340 }}
                tableLayout="fixed"
                onRow={(project) => ({
                  onClick: (event) => {
                    if (ignoreProjectRowClick(event.target)) return;
                    if (!projectActionAvailable(project)) return;
                    void handleProjectAction(project);
                  },
                  style: {
                    cursor: projectActionAvailable(project)
                      ? "pointer"
                      : "default",
                  },
                })}
                pagination={{
                  pageSize,
                  showSizeChanger: true,
                  showTotal: (total, range) =>
                    `${range[0]}-${range[1]} of ${total.toLocaleString()} loaded`,
                  total: filteredProjects.length,
                  onChange: (_page, size) => setPageSize(size),
                  onShowSizeChange: (_page, size) => setPageSize(size),
                }}
                rowKey="legacy_project_id"
                rowSelection={{
                  getCheckboxProps: (project) => ({
                    disabled: !bulkRestoreSelectable(project),
                    title: bulkRestoreSelectable(project)
                      ? "Select this project for bulk restore."
                      : "Only not-yet-restored projects with available archives can be selected.",
                  }),
                  onChange: (keys) => setSelectedLegacyProjectKeys([...keys]),
                  preserveSelectedRowKeys: true,
                  selectedRowKeys: selectedLegacyProjectIds,
                }}
              />
              <LegacyProjectImportModal
                project={importProject}
                open={importProject != null}
                onClose={() => setImportProject(undefined)}
                onImported={openImportedProject}
              />
              <LegacyProjectBulkImportModal
                projects={selectedProjects}
                open={bulkImportOpen}
                onClose={() => setBulkImportOpen(false)}
                onImported={handleBulkImported}
              />
            </>
          )}
        </Space>
      </Card>
    </Space>
  );
}
