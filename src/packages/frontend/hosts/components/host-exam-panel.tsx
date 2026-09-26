/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Checkbox,
  Collapse,
  DatePicker,
  Descriptions,
  Divider,
  Input,
  InputNumber,
  Popconfirm,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
  message,
} from "antd";
import { BookOutlined, LoadingOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { type CSSProperties, useRef } from "react";
import { useEffect, useMemo, useState } from "@cocalc/frontend/app-framework";
import type {
  Host,
  HostExamCleanupMode,
  HostExamConfig,
  HostExamConfigInput,
  HostExamRun,
  HostExamState,
  HostRootfsImage,
} from "@cocalc/conat/hub/api/hosts";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { openAppDocs } from "@cocalc/frontend/docs/navigation";
import { RootfsCatalogPicker } from "@cocalc/frontend/rootfs/catalog-picker";
import { latestRootfsVersionEntries } from "@cocalc/frontend/rootfs/catalog-ui";
import {
  managedRootfsCatalogUrl,
  useRootfsImages,
} from "@cocalc/frontend/rootfs/manifest";
import { isSpotHost } from "@cocalc/frontend/hosts/spot-ui";
import {
  getHostCpuCount,
  getHostRamGiB,
} from "@cocalc/frontend/hosts/utils/format";
import { isNewProjectRootfsSelectable } from "@cocalc/frontend/projects/create-project-rootfs";
import {
  type ProjectCreateMode,
  rootfsEntryMatchesProjectMode,
} from "@cocalc/frontend/projects/create/project-create-draft";
import {
  managedRootfsContentKey,
  type RootfsImageEntry,
} from "@cocalc/util/rootfs-images";

const DEFAULT_CONFIG: HostExamConfigInput = {
  enabled: false,
  title: "Exam Scratchpad",
  max_projects: 100,
  project_cpu: 1,
  project_memory_mb: 2_000,
  project_disk_mb: 5_000,
  project_ttl_minutes: 360,
  cleanup_grace_minutes: 10,
  terminal_enabled: false,
  network_mode: "disabled",
};

const RECOMMENDED_EXAM_CPU = 8;
const SUBSTANTIALLY_LOW_CPU = 4;
const SUBSTANTIALLY_LOW_RAM_RATIO = 0.4;
const EXAM_STATE_TIMEOUT_MS = 30_000;
const EXAM_MUTATION_TIMEOUT_MS = 2 * 60_000;
const EXAM_LIFECYCLE_TIMEOUT_MS = 12 * 60_000;
const EXAM_TRANSIENT_POLL_MS = 2_000;
const EXAM_TRANSIENT_STATUSES = new Set(["preparing", "closing", "cleaning"]);
const EXAM_ROOTFS_PRESETS: Array<{
  mode: ProjectCreateMode;
  label: string;
}> = [
  { mode: "standard", label: "Standard" },
  { mode: "gpu", label: "GPU" },
  { mode: "teaching", label: "Teaching" },
  { mode: "custom", label: "All images" },
];

// Wrapping a control and its visible text in one <label> gives the control an
// accessible name, as the number inputs in this panel already do.
const SWITCH_LABEL_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
};
const FIELD_LABEL_STYLE: CSSProperties = {
  display: "inline-flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 8,
};

// What each readiness check means, from readinessForRow and applyExamRunLocal
// in project-host/exam/controller.ts. Only host_running and watchdog describe
// the host now; the others turn green once preparation, which performed the
// underlying test, has succeeded.
// What each readiness check means. Keep in step with readinessForRow in
// project-host/exam/controller.ts: only host_running and watchdog are live
// there; the others follow the run's status, so they report what preparation
// verified. If that changes, change these texts and the "What these checks
// mean" note below.
export const EXAM_READINESS_DESCRIPTIONS: Record<string, string> = {
  host_running: "The project host answered this status request.",
  public_route:
    "Preparation confirmed that the student web address reaches this host.",
  rootfs: "Preparation pinned the software image to the exact version shown.",
  local_snapshot:
    "Preparation created its test project in this host's local storage.",
  network_policy:
    "Preparation confirmed that a test project could not look up or connect to Internet addresses.",
  project_smoke:
    "Preparation created a test project, wrote a file, ran a Python 3 notebook in it, and erased it.",
  watchdog:
    "The host's deadline check is running; it erases the projects when the deletion time passes.",
};

// Confirms that the most recent run ended and its projects are gone. It is not
// presented as a current run. A run is marked stopped only after every student
// project was erased; otherwise it ends in "error"
// (project-host/exam/controller.ts).
function LastExamRun({ run }: { run: HostExamRun }) {
  const ended = run.stopped_at ?? run.cleaned_at ?? run.updated_at;
  return (
    <Card size="small" title="Last run">
      <Descriptions size="small" column={1}>
        <Descriptions.Item label="Ended">
          {dayjs(ended).format("YYYY-MM-DD HH:mm Z")}
        </Descriptions.Item>
        <Descriptions.Item label="Student projects">
          all erased
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

function defaultExamDeadline(projectTtlMinutes: number): Dayjs {
  // Keep clear of both server boundaries: at least one minute ahead and no
  // later than the configured maximum run measured from request time.
  const minutes = Math.max(2, Math.min(360, projectTtlMinutes - 1));
  return dayjs().add(minutes, "minute").startOf("minute");
}

function editableExamConfig(config: HostExamConfig): HostExamConfigInput {
  return {
    enabled: config.enabled,
    title: config.title,
    max_projects: config.max_projects,
    project_cpu: config.project_cpu,
    project_memory_mb: config.project_memory_mb,
    project_disk_mb: config.project_disk_mb,
    project_ttl_minutes: config.project_ttl_minutes,
    cleanup_grace_minutes: config.cleanup_grace_minutes,
    terminal_enabled: config.terminal_enabled,
    network_mode: "disabled",
  };
}

function sameExamConfig(
  left: HostExamConfigInput,
  right: HostExamConfigInput,
): boolean {
  return (
    left.enabled === right.enabled &&
    (left.title ?? "Exam Scratchpad").trim() ===
      (right.title ?? "Exam Scratchpad").trim() &&
    left.max_projects === right.max_projects &&
    left.project_cpu === right.project_cpu &&
    left.project_memory_mb === right.project_memory_mb &&
    left.project_disk_mb === right.project_disk_mb &&
    left.project_ttl_minutes === right.project_ttl_minutes &&
    left.cleanup_grace_minutes === right.cleanup_grace_minutes &&
    !!left.terminal_enabled === !!right.terminal_enabled &&
    (left.network_mode ?? "disabled") === (right.network_mode ?? "disabled")
  );
}

export type ExamHostCapacityAssessment = {
  level: "success" | "close" | "warning" | "unknown";
  recommendedCpu: number;
  recommendedRamGiB: number;
};

export function assessExamHostCapacity({
  maxProjects,
  cpu,
  ramGiB,
}: {
  maxProjects: number;
  cpu?: number;
  ramGiB?: number;
}): ExamHostCapacityAssessment {
  // The strict guidance is RAM (GB) > 3 + students / 2. Host sizes use
  // whole GiB, so round up to the smallest integer that satisfies it.
  const recommendedRamGiB = Math.floor(3 + Math.max(1, maxProjects) / 2) + 1;
  const recommendation = {
    recommendedCpu: RECOMMENDED_EXAM_CPU,
    recommendedRamGiB,
  };
  if (cpu == null || ramGiB == null) {
    return { level: "unknown", ...recommendation };
  }
  if (cpu >= RECOMMENDED_EXAM_CPU && ramGiB >= recommendedRamGiB) {
    return { level: "success", ...recommendation };
  }
  if (
    cpu < SUBSTANTIALLY_LOW_CPU ||
    ramGiB < recommendedRamGiB * SUBSTANTIALLY_LOW_RAM_RATIO
  ) {
    return { level: "warning", ...recommendation };
  }
  return { level: "close", ...recommendation };
}

function ExamHostCapacityAlert({
  host,
  maxProjects,
}: {
  host: Host;
  maxProjects: number;
}) {
  const cpu = getHostCpuCount(host);
  const ramGiB = getHostRamGiB(host);
  const assessment = assessExamHostCapacity({ maxProjects, cpu, ramGiB });
  const students = Math.max(1, maxProjects);
  const guidance = `For ${students} simultaneous students, we recommend at least ${assessment.recommendedCpu} vCPU and ${assessment.recommendedRamGiB} GB RAM.`;
  const actual =
    cpu != null && ramGiB != null
      ? ` This host has ${cpu} vCPU and ${ramGiB} GB RAM.`
      : " CoCalc cannot determine this host's CPU and RAM yet.";

  if (assessment.level === "success") {
    return (
      <Alert
        type="success"
        showIcon
        title="Host capacity meets the exam guideline"
        description={`${guidance}${actual}`}
      />
    );
  }
  if (assessment.level === "unknown") {
    return (
      <Alert
        type="info"
        showIcon
        title="Confirm host capacity before the exam"
        description={`${guidance}${actual} This advisory does not block exam setup.`}
      />
    );
  }
  if (assessment.level === "warning") {
    return (
      <Alert
        type="error"
        showIcon
        title="Host capacity is substantially below exam guidance"
        description={`${guidance}${actual} Resize the host or complete a representative full-load rehearsal before a live exam. This advisory does not block exam setup.`}
      />
    );
  }
  return (
    <Alert
      type="warning"
      showIcon
      title="Host capacity is below the recommended headroom"
      description={`${guidance}${actual} The workload may still fit, but complete a representative full-load rehearsal before the exam. This advisory does not block exam setup.`}
    />
  );
}

function idempotencyKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function statusColor(status?: string): string {
  switch (status) {
    case "open":
      return "green";
    case "ready":
      return "blue";
    case "preparing":
    case "cleaning":
    case "closing":
      return "orange";
    case "error":
      return "red";
    default:
      return "default";
  }
}

export function examRootfsCatalogEntries({
  cachedImages,
  catalogImages,
}: {
  cachedImages: HostRootfsImage[];
  catalogImages: RootfsImageEntry[];
}): RootfsImageEntry[] {
  const cached = cachedImages.filter((entry) => !!entry.digest);
  const used = new Set<string>();
  const entries: RootfsImageEntry[] = catalogImages.map((catalog) => {
    const match = cached.find((entry) => entry.image === catalog.image);
    if (match) used.add(match.image);
    return { ...catalog, digest: match?.digest ?? catalog.digest };
  });
  for (const entry of cached) {
    if (used.has(entry.image)) continue;
    const contentKey = managedRootfsContentKey(entry.image);
    entries.push({
      id: entry.release_id || entry.image,
      release_id: entry.release_id,
      image: entry.image,
      digest: entry.digest,
      label: contentKey
        ? `Cached RootFS ${contentKey.slice(0, 12)}…`
        : entry.image,
      description: "This immutable RootFS is cached on the project host.",
    });
  }
  return entries;
}

export function HostExamPanel({
  host,
  rootfsImages,
}: {
  host: Host;
  rootfsImages: HostRootfsImage[];
}) {
  const [state, setState] = useState<HostExamState>();
  const [config, setConfig] = useState<HostExamConfigInput>(DEFAULT_CONFIG);
  const [rootfsImage, setRootfsImage] = useState<string>();
  const [deadline, setDeadline] = useState<Dayjs>(() =>
    defaultExamDeadline(DEFAULT_CONFIG.project_ttl_minutes),
  );
  const [stopHostAtDeadline, setStopHostAtDeadline] = useState(true);
  const [cleanupMode, setCleanupMode] =
    useState<HostExamCleanupMode>("scheduled");
  const [runCapacity, setRunCapacity] = useState<number>();
  const [token, setToken] = useState("");
  const [savedToken, setSavedToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<"prepare">();
  const [error, setError] = useState("");
  const [rootfsSearch, setRootfsSearch] = useState("");
  const [rootfsPreset, setRootfsPreset] =
    useState<ProjectCreateMode>("standard");
  const [showOlderRootfsVersions, setShowOlderRootfsVersions] = useState(false);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  // Practice mode never shuts the host down, so turning it on clears that
  // choice. Remember the choice so that turning practice mode off restores it.
  const shutdownBeforePractice = useRef<boolean | null>(null);
  const setPracticeMode = (manual: boolean) => {
    setCleanupMode(manual ? "manual" : "scheduled");
    if (manual) {
      shutdownBeforePractice.current = stopHostAtDeadline;
      setStopHostAtDeadline(false);
    } else {
      setStopHostAtDeadline(shutdownBeforePractice.current ?? true);
      shutdownBeforePractice.current = null;
    }
  };
  const api = webapp_client.conat_client.hub.hosts;
  const {
    images: rootfsCatalog,
    loading: rootfsCatalogLoading,
    error: rootfsCatalogError,
  } = useRootfsImages([managedRootfsCatalogUrl()], { limit: 1000 });
  const selectableRootfsImages = useMemo(() => {
    const entries = examRootfsCatalogEntries({
      cachedImages: rootfsImages,
      catalogImages: rootfsCatalog,
    });
    const catalogImages = new Set(rootfsCatalog.map((entry) => entry.image));
    const hostHasGpu =
      host.gpu === true || Number(host.machine?.gpu_count ?? 0) > 0;
    return entries.filter(
      (entry) =>
        !catalogImages.has(entry.image) ||
        isNewProjectRootfsSelectable({
          entry,
          isGpu: hostHasGpu,
        }),
    );
  }, [host.gpu, host.machine?.gpu_count, rootfsCatalog, rootfsImages]);
  const pickerRootfsImages = useMemo(
    () =>
      latestRootfsVersionEntries(
        selectableRootfsImages.filter(
          (entry) =>
            entry.image === rootfsImage ||
            rootfsEntryMatchesProjectMode(entry, rootfsPreset),
        ),
        {
          showOlderVersions: showOlderRootfsVersions,
          preserveIds: selectableRootfsImages
            .filter((entry) => entry.image === rootfsImage)
            .map((entry) => entry.id),
        },
      ),
    [
      rootfsImage,
      rootfsPreset,
      selectableRootfsImages,
      showOlderRootfsVersions,
    ],
  );

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await api.getHostExamState({
        id: host.id,
        timeout: EXAM_STATE_TIMEOUT_MS,
      });
      setState(next);
      setToken(next.token ?? "");
      setSavedToken(next.token ?? "");
      if (next.config) {
        setConfig(editableExamConfig(next.config));
      }
      if (next.run && next.run.status !== "stopped") {
        setRootfsImage(next.run.rootfs_image);
        setDeadline(dayjs(next.run.scheduled_stop_at));
        setCleanupMode(next.run.cleanup_mode);
        setStopHostAtDeadline(next.run.stop_host_at_deadline !== false);
        setRunCapacity(next.run.max_projects);
      } else {
        if (next.run?.rootfs_image) {
          setRootfsImage(next.run.rootfs_image);
        }
        setDeadline(
          defaultExamDeadline(
            next.config?.project_ttl_minutes ??
              DEFAULT_CONFIG.project_ttl_minutes,
          ),
        );
        setStopHostAtDeadline(true);
        setCleanupMode("scheduled");
        setRunCapacity(undefined);
      }
    } catch (err) {
      setError(`${(err as Error)?.message ?? err}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [host.id, host.status]);

  useEffect(() => {
    const status = state?.run?.status;
    if (loading || status == null || !EXAM_TRANSIENT_STATUSES.has(status)) {
      return;
    }
    const timer = window.setTimeout(() => {
      void refresh();
    }, EXAM_TRANSIENT_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [host.id, loading, state?.run?.status]);

  useEffect(() => {
    if (rootfsImage || selectableRootfsImages.length === 0) return;
    const preferred = selectableRootfsImages.find((entry) =>
      rootfsEntryMatchesProjectMode(entry, "standard"),
    );
    setRootfsImage(preferred?.image ?? selectableRootfsImages[0].image);
  }, [rootfsImage, selectableRootfsImages]);

  const mutate = async (
    action: () => Promise<HostExamState & { token?: string }>,
    actionName?: "prepare",
  ) => {
    setError("");
    try {
      const completed = await runFreshAuthAction(async () => {
        setPendingAction(actionName);
        setLoading(true);
        setError("");
        try {
          const next = await action();
          setState(next);
          setToken(next.token ?? "");
          setSavedToken(next.token ?? "");
        } finally {
          setLoading(false);
          setPendingAction(undefined);
        }
      });
      if (completed) {
        message.success(
          actionName === "prepare"
            ? "Exam run prepared and tested"
            : "Exam host updated",
        );
      }
    } catch (err) {
      const text = `${(err as Error)?.message ?? err}`;
      await refresh();
      setError(text);
      message.error(text);
    }
  };

  const mutateIdempotently = (
    prefix: string,
    action: (
      idempotency_key: string,
    ) => Promise<HostExamState & { token?: string }>,
    actionName?: "prepare",
  ) => {
    // A fresh-auth challenge may invoke the action again after elevation. One
    // click is still one logical mutation, so every retry must reuse its key.
    const idempotency_key = idempotencyKey(prefix);
    return mutate(() => action(idempotency_key), actionName);
  };

  const run = state?.run;
  const runtime = state?.runtime;
  // The catalog name of the run's image, when the catalog knows it.
  const runRootfsLabel = useMemo(() => {
    const image = run?.rootfs_image;
    if (!image) return undefined;
    const entry =
      selectableRootfsImages.find((candidate) => candidate.image === image) ??
      rootfsCatalog.find((candidate) => candidate.image === image);
    return entry?.label && entry.label !== image ? entry.label : undefined;
  }, [run?.rootfs_image, selectableRootfsImages, rootfsCatalog]);
  const hostStatus = state?.host_status ?? host.status;
  const hostRunning = hostStatus === "running";
  const hasActiveRun = !!run && run.status !== "stopped";
  const configDirty =
    state != null &&
    (!state.config ||
      !sameExamConfig(config, editableExamConfig(state.config)) ||
      token !== savedToken);
  const selectedRootfsIsAvailable = selectableRootfsImages.some(
    (entry) => entry.image === rootfsImage,
  );
  const now = Date.now();
  const earliestDeadline = now + 60_000;
  const latestDeadline = now + config.project_ttl_minutes * 60_000;
  const deadlineTooSoon = deadline.valueOf() < earliestDeadline;
  const deadlineTooLate = deadline.valueOf() > latestDeadline;
  const prepareBlockers = [
    !config.enabled ? "Enable and save exam mode." : undefined,
    configDirty ? "Save the exam configuration changes." : undefined,
    !hostRunning ? "Start the project host." : undefined,
    !selectedRootfsIsAvailable
      ? "Select a RootFS image from the managed catalog."
      : undefined,
    cleanupMode === "scheduled" && deadlineTooSoon
      ? "Choose a project-deletion time at least one minute in the future."
      : undefined,
    cleanupMode === "scheduled" && deadlineTooLate
      ? `Choose a project-deletion time within the configured ${config.project_ttl_minutes}-minute maximum run.`
      : undefined,
  ].filter((value): value is string => !!value);
  const canPrepare = !hasActiveRun && prepareBlockers.length === 0;
  const runScheduleDirty =
    !!run &&
    (run.cleanup_mode !== cleanupMode ||
      (cleanupMode === "scheduled" &&
        dayjs(run.scheduled_stop_at).valueOf() !== deadline.valueOf()) ||
      (run.stop_host_at_deadline !== false) !== stopHostAtDeadline);
  const requestedRunCapacity = runCapacity ?? run?.max_projects ?? 1;
  const studentUrl = state?.config?.hostname
    ? `https://${state.config.hostname}`
    : undefined;
  const admissionUrl =
    studentUrl && savedToken
      ? `${studentUrl}/#token=${encodeURIComponent(savedToken)}`
      : undefined;

  return (
    // Preparation can take minutes; its progress is shown inside the "Prepare
    // an exam run" card instead of dimming the whole tab.
    <Spin spinning={loading && pendingAction !== "prepare"}>
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          title="Ephemeral exam scratchpads"
          description={
            <>
              Students get anonymous local projects on this project host.
              Outbound project networking is disabled. Existing private-host
              billing applies.
              <br />
              <Button
                icon={<BookOutlined />}
                onClick={() => openAppDocs("hosts/exam-scratchpads")}
                size="small"
                style={{ height: "auto", padding: 0 }}
                type="link"
              >
                Read the setup, testing, and cleanup guide.
              </Button>
            </>
          }
        />
        {isSpotHost(host) && (
          <Alert
            type="warning"
            showIcon
            title="Spot capacity can be interrupted during an exam"
            description="This host may be stopped or restarted by the cloud provider at any time. Spot is useful for testing and non-critical scratchpads, but use Standard/on-demand capacity for a live exam."
          />
        )}
        {error && <Alert type="error" showIcon title={error} />}
        {!hostRunning && (
          <Alert
            type="warning"
            showIcon
            title="Start the project host to prepare an exam"
            description={`The host is currently ${hostStatus || "unavailable"}. Saved exam configuration remains available, but preparation and live status checks require the host to be running.`}
          />
        )}
        {state && !state.eligible && (
          <Alert
            type="warning"
            showIcon
            title="Exam mode is not enabled for this account"
            description={state.eligibility_reason}
          />
        )}

        <Card size="small" title="Host configuration">
          <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
            <label style={SWITCH_LABEL_STYLE}>
              <Switch
                checked={config.enabled}
                disabled={hasActiveRun || state?.eligible === false}
                onChange={(enabled) =>
                  setConfig((value) => ({ ...value, enabled }))
                }
              />
              <Typography.Text strong>Enable exam mode</Typography.Text>
            </label>
            <label>
              Public scratchpad title
              <Input
                maxLength={100}
                value={config.title}
                placeholder="Exam Scratchpad"
                onChange={(event) =>
                  setConfig((value) => ({
                    ...value,
                    title: event.target.value,
                  }))
                }
              />
            </label>
            <Space
              orientation="vertical"
              size="small"
              style={{ width: "100%" }}
            >
              <Typography.Text strong>Stable admission token</Typography.Text>
              <Space.Compact style={{ width: "100%" }}>
                <Input
                  aria-label="Stable exam admission token"
                  value={token}
                  minLength={8}
                  maxLength={200}
                  disabled={hasActiveRun}
                  onChange={(event) => setToken(event.target.value)}
                />
                <Button
                  disabled={!token}
                  onClick={() => void navigator.clipboard.writeText(token)}
                >
                  Copy token
                </Button>
              </Space.Compact>
              <Typography.Text type="secondary">
                This token and its admission link remain unchanged across exam
                runs and host restarts. Change it only when you explicitly want
                a new link.
              </Typography.Text>
              {admissionUrl && (
                <Space.Compact style={{ width: "100%" }}>
                  <Input
                    aria-label="Stable student admission link"
                    value={admissionUrl}
                    readOnly
                  />
                  <Button
                    onClick={() =>
                      void navigator.clipboard.writeText(admissionUrl)
                    }
                  >
                    Copy link
                  </Button>
                </Space.Compact>
              )}
            </Space>
            <Space wrap>
              <label>
                Maximum projects (students)
                <InputNumber
                  min={1}
                  max={1000}
                  value={config.max_projects}
                  onChange={(value) =>
                    setConfig((current) => ({
                      ...current,
                      max_projects: Number(value ?? 1),
                    }))
                  }
                />
              </label>
              <label>
                CPU per project
                <InputNumber
                  min={0.1}
                  max={128}
                  step={0.5}
                  value={config.project_cpu}
                  onChange={(value) =>
                    setConfig((current) => ({
                      ...current,
                      project_cpu: Number(value ?? 1),
                    }))
                  }
                />
              </label>
              <label>
                Memory (MB)
                <InputNumber
                  min={256}
                  value={config.project_memory_mb}
                  onChange={(value) =>
                    setConfig((current) => ({
                      ...current,
                      project_memory_mb: Number(value ?? 256),
                    }))
                  }
                />
              </label>
              <label>
                Disk (MB)
                <InputNumber
                  min={1000}
                  value={config.project_disk_mb}
                  onChange={(value) =>
                    setConfig((current) => ({
                      ...current,
                      project_disk_mb: Number(value ?? 1000),
                    }))
                  }
                />
              </label>
              <label>
                Maximum run (minutes)
                <InputNumber
                  min={180}
                  max={2880}
                  value={config.project_ttl_minutes}
                  onChange={(value) =>
                    setConfig((current) => ({
                      ...current,
                      project_ttl_minutes: Number(value ?? 180),
                    }))
                  }
                />
              </label>
              <label>
                Cleanup grace (minutes)
                <InputNumber
                  min={1}
                  max={60}
                  value={config.cleanup_grace_minutes}
                  onChange={(value) =>
                    setConfig((current) => ({
                      ...current,
                      cleanup_grace_minutes: Number(value ?? 10),
                    }))
                  }
                />
              </label>
            </Space>
            <ExamHostCapacityAlert
              host={host}
              maxProjects={config.max_projects}
            />
            <label style={SWITCH_LABEL_STYLE}>
              <Switch
                checked={config.terminal_enabled}
                onChange={(terminal_enabled) =>
                  setConfig((value) => ({ ...value, terminal_enabled }))
                }
              />
              <Typography.Text>
                Allow terminals (disabled by default)
              </Typography.Text>
            </label>
            <Button
              type="primary"
              disabled={
                loading ||
                hasActiveRun ||
                state?.eligible === false ||
                !configDirty
              }
              onClick={() =>
                void mutate(() =>
                  api.setHostExamConfig({
                    id: host.id,
                    browser_id: webapp_client.browser_id,
                    config: {
                      ...config,
                      admission_token: token || undefined,
                    },
                    timeout: EXAM_MUTATION_TIMEOUT_MS,
                  }),
                )
              }
            >
              Save configuration
            </Button>
          </Space>
        </Card>

        {run?.status === "stopped" && <LastExamRun run={run} />}

        {!hasActiveRun && (
          <Card size="small" title="Prepare an exam run">
            <Space
              orientation="vertical"
              size="middle"
              style={{ width: "100%" }}
            >
              <Space size={4} wrap>
                {EXAM_ROOTFS_PRESETS.map(({ mode, label }) => (
                  <Button
                    key={mode}
                    size="small"
                    type={rootfsPreset === mode ? "primary" : "default"}
                    aria-pressed={rootfsPreset === mode}
                    onClick={() => {
                      setRootfsPreset(mode);
                      setRootfsSearch("");
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </Space>
              <RootfsCatalogPicker
                images={pickerRootfsImages}
                selectedImage={rootfsImage}
                onSelect={(entry) => setRootfsImage(entry.image)}
                loading={
                  rootfsCatalogLoading && pickerRootfsImages.length === 0
                }
                disabled={loading || !hostRunning}
                search={rootfsSearch}
                onSearchChange={setRootfsSearch}
                searchPlaceholder="Search by name, image, publisher, tag, or version"
                emptyText="No managed RootFS images match this filter and search."
                height={320}
              />
              <Checkbox
                checked={showOlderRootfsVersions}
                onChange={(event) =>
                  setShowOlderRootfsVersions(event.target.checked)
                }
                disabled={loading}
              >
                Show older versions
              </Checkbox>
              {rootfsCatalogError && (
                <Typography.Text type="secondary">
                  Catalog metadata is unavailable; any already cached images
                  remain selectable. {rootfsCatalogError}
                </Typography.Text>
              )}
              <Checkbox
                checked={cleanupMode === "manual"}
                onChange={(event) => setPracticeMode(event.target.checked)}
                disabled={loading}
              >
                Practice mode: erase projects manually (no automatic timeout)
              </Checkbox>
              {cleanupMode === "manual" ? (
                <Alert
                  type="warning"
                  showIcon
                  title="Projects remain until you end and erase the session"
                  description="Admission and every student project remain available until an instructor selects End and erase. The project host also keeps running and billing normally."
                />
              ) : (
                <>
                  <label style={FIELD_LABEL_STYLE}>
                    <Typography.Text strong>
                      Delete all exam projects at
                    </Typography.Text>
                    <DatePicker
                      showTime
                      showNow={false}
                      value={deadline}
                      onChange={(value) => value && setDeadline(value)}
                      minDate={dayjs()}
                      disabled={loading}
                      status={
                        deadlineTooSoon || deadlineTooLate ? "error" : undefined
                      }
                    />
                  </label>
                  <Checkbox
                    checked={stopHostAtDeadline}
                    onChange={(event) =>
                      setStopHostAtDeadline(event.target.checked)
                    }
                    disabled={loading}
                  >
                    Also shut down the project host to save resources
                  </Checkbox>
                </>
              )}
              {pendingAction === "prepare" ? (
                <div role="status" aria-live="polite">
                  <Alert
                    type="info"
                    showIcon
                    icon={<LoadingOutlined spin />}
                    title="Preparing and testing the exam environment"
                    description="Downloading the RootFS when needed, creating a smoke-test project, starting Jupyter, checking network isolation and cleanup, then erasing the test project. A first download may take several minutes."
                  />
                </div>
              ) : (
                <Alert
                  type="info"
                  showIcon
                  title="Preparation runs a complete rehearsal"
                  description="CoCalc downloads the selected RootFS to this host when needed, pins its immutable digest and limits, creates an isolated smoke-test project, starts Jupyter, verifies network isolation and cleanup, then erases the test project. A first download may take several minutes. Admission remains closed until you select Open admission."
                />
              )}
              {prepareBlockers.length > 0 && (
                <Alert
                  type="info"
                  showIcon
                  title="Complete these steps before preparing the run"
                  description={prepareBlockers.join(" ")}
                />
              )}
              <Button
                type="primary"
                loading={pendingAction === "prepare"}
                disabled={loading || !canPrepare}
                onClick={() => {
                  void mutateIdempotently(
                    "create",
                    (idempotency_key) =>
                      api.createHostExamRun({
                        id: host.id,
                        browser_id: webapp_client.browser_id,
                        rootfs_image: rootfsImage!,
                        cleanup_mode: cleanupMode,
                        scheduled_stop_at:
                          cleanupMode === "scheduled"
                            ? deadline.toISOString()
                            : undefined,
                        stop_host_at_deadline: stopHostAtDeadline,
                        idempotency_key,
                        timeout: EXAM_LIFECYCLE_TIMEOUT_MS,
                      }),
                    "prepare",
                  );
                }}
              >
                Prepare and test run
              </Button>
            </Space>
          </Card>
        )}

        {hasActiveRun && run && (
          <Card
            size="small"
            title={
              <Space>
                Current run
                <Tag color={statusColor(run.status)}>{run.status}</Tag>
              </Space>
            }
          >
            <Descriptions size="small" column={1}>
              <Descriptions.Item label="Student URL">
                {studentUrl ? (
                  <Typography.Link href={studentUrl} target="_blank">
                    {studentUrl}
                  </Typography.Link>
                ) : (
                  "not configured"
                )}
              </Descriptions.Item>
              <Descriptions.Item label="RootFS">
                <span>
                  {runRootfsLabel && <>{runRootfsLabel} </>}
                  <code>{run.rootfs_image}</code>
                </span>
              </Descriptions.Item>
              <Descriptions.Item label="Project cleanup">
                {run.cleanup_mode === "manual"
                  ? "manual; no automatic timeout"
                  : dayjs(run.scheduled_stop_at).format("YYYY-MM-DD HH:mm Z")}
              </Descriptions.Item>
              <Descriptions.Item label="Project host afterward">
                {run.stop_host_at_deadline !== false
                  ? "shuts down to save resources"
                  : "keeps running"}
              </Descriptions.Item>
              <Descriptions.Item label="Projects">
                {runtime?.active_projects ?? 0} / {run.max_projects}
              </Descriptions.Item>
              <Descriptions.Item label="Terminal">
                {run.terminal_enabled ? "allowed" : "disabled"}
              </Descriptions.Item>
              <Descriptions.Item label="Network">
                outbound disabled
              </Descriptions.Item>
            </Descriptions>
            {runtime?.readiness && (
              <Space orientation="vertical" size={4} style={{ width: "100%" }}>
                <Space wrap>
                  {runtime.readiness.map((check) => (
                    <Tag key={check.name} color={check.ok ? "green" : "red"}>
                      {check.name}
                    </Tag>
                  ))}
                </Space>
                <Collapse
                  ghost
                  size="small"
                  items={[
                    {
                      key: "checks",
                      label: "What these checks mean",
                      children: (
                        <>
                          <Typography.Paragraph type="secondary">
                            Only host_running and watchdog describe the host
                            right now. The other checks ran while the run was
                            prepared and are not repeated.
                          </Typography.Paragraph>
                          <ul style={{ margin: 0, paddingLeft: 20 }}>
                            {runtime.readiness.map((check) => (
                              <li key={check.name}>
                                <Typography.Text code>
                                  {check.name}
                                </Typography.Text>{" "}
                                {check.ok ? "passed" : "failed"}:{" "}
                                {EXAM_READINESS_DESCRIPTIONS[check.name] ??
                                  "A readiness check reported by the host."}
                                {check.detail ? (
                                  <>
                                    {" "}
                                    <Typography.Text type="secondary">
                                      {check.detail}
                                    </Typography.Text>
                                  </>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        </>
                      ),
                    },
                  ]}
                />
              </Space>
            )}
            {(run.status === "ready" || run.status === "open") && (
              <>
                <Divider />
                <Space
                  orientation="vertical"
                  size="small"
                  style={{ width: "100%" }}
                >
                  <Space wrap align="center">
                    <Typography.Text strong>
                      Maximum students for this run
                    </Typography.Text>
                    <InputNumber
                      aria-label="Maximum students for this run"
                      min={run.max_projects}
                      max={1_000}
                      precision={0}
                      value={requestedRunCapacity}
                      onChange={(value) =>
                        setRunCapacity(Number(value ?? run.max_projects))
                      }
                    />
                    <Button
                      disabled={
                        loading || requestedRunCapacity <= run.max_projects
                      }
                      onClick={() => {
                        void mutateIdempotently("capacity", (idempotency_key) =>
                          api.increaseHostExamCapacity({
                            id: host.id,
                            browser_id: webapp_client.browser_id,
                            run_id: run.run_id,
                            max_projects: requestedRunCapacity,
                            idempotency_key,
                            timeout: EXAM_MUTATION_TIMEOUT_MS,
                          }),
                        );
                      }}
                    >
                      Increase capacity
                    </Button>
                  </Space>
                  <Typography.Text type="secondary">
                    One student uses one temporary project. Capacity can be
                    increased immediately during an exam, but cannot be reduced.
                    The saved default remains{" "}
                    {state?.config?.max_projects ?? run.max_projects}.
                  </Typography.Text>
                  {requestedRunCapacity > run.max_projects && (
                    <ExamHostCapacityAlert
                      host={host}
                      maxProjects={requestedRunCapacity}
                    />
                  )}
                </Space>
              </>
            )}
            {token && (
              <>
                <Divider />
                <Space
                  orientation="vertical"
                  size="small"
                  style={{ width: "100%" }}
                >
                  <Alert
                    type="info"
                    title="Student admission"
                    description="You may publish the stable link above now. It prefills the token without sending it to the server in the URL, remains unchanged across host restarts and future runs, and admits students only after you open admission."
                  />
                </Space>
              </>
            )}
            {(run.status === "ready" || run.status === "open") && (
              <>
                <Divider />
                <Space
                  orientation="vertical"
                  size="small"
                  style={{ width: "100%" }}
                >
                  <Typography.Text type="secondary">Admission</Typography.Text>
                  <Space wrap>
                    {run.status === "ready" && (
                      <Button
                        type="primary"
                        disabled={loading}
                        onClick={() => {
                          void mutateIdempotently("open", (idempotency_key) =>
                            api.openHostExamRun({
                              id: host.id,
                              browser_id: webapp_client.browser_id,
                              run_id: run.run_id,
                              idempotency_key,
                              timeout: EXAM_MUTATION_TIMEOUT_MS,
                            }),
                          );
                        }}
                      >
                        Open admission
                      </Button>
                    )}
                    <Button
                      disabled={loading}
                      onClick={() => {
                        void mutateIdempotently("rotate", (idempotency_key) =>
                          api.rotateHostExamToken({
                            id: host.id,
                            browser_id: webapp_client.browser_id,
                            run_id: run.run_id,
                            idempotency_key,
                            timeout: EXAM_MUTATION_TIMEOUT_MS,
                          }),
                        );
                      }}
                    >
                      Rotate token
                    </Button>
                  </Space>
                </Space>
                <Divider />
                <Space
                  orientation="vertical"
                  size="small"
                  style={{ width: "100%" }}
                >
                  <Typography.Text type="secondary">Cleanup</Typography.Text>
                  <Checkbox
                    checked={cleanupMode === "manual"}
                    onChange={(event) => setPracticeMode(event.target.checked)}
                  >
                    Practice mode: erase projects manually (no automatic
                    timeout)
                  </Checkbox>
                  {cleanupMode === "scheduled" && (
                    <>
                      <label style={FIELD_LABEL_STYLE}>
                        <Typography.Text strong>
                          Delete all exam projects at
                        </Typography.Text>
                        <DatePicker
                          showTime
                          showNow={false}
                          value={deadline}
                          onChange={(value) => value && setDeadline(value)}
                          minDate={dayjs()}
                          status={
                            deadlineTooSoon || deadlineTooLate
                              ? "error"
                              : undefined
                          }
                        />
                      </label>
                      <Checkbox
                        checked={stopHostAtDeadline}
                        onChange={(event) =>
                          setStopHostAtDeadline(event.target.checked)
                        }
                      >
                        Also shut down the project host to save resources
                      </Checkbox>
                    </>
                  )}
                  <div>
                    <Button
                      disabled={
                        loading ||
                        !runScheduleDirty ||
                        (cleanupMode === "scheduled" &&
                          (deadlineTooSoon || deadlineTooLate))
                      }
                      onClick={() => {
                        void mutateIdempotently("deadline", (idempotency_key) =>
                          api.updateHostExamDeadline({
                            id: host.id,
                            browser_id: webapp_client.browser_id,
                            run_id: run.run_id,
                            cleanup_mode: cleanupMode,
                            scheduled_stop_at:
                              cleanupMode === "scheduled"
                                ? deadline.toISOString()
                                : undefined,
                            stop_host_at_deadline: stopHostAtDeadline,
                            idempotency_key,
                            timeout: EXAM_MUTATION_TIMEOUT_MS,
                          }),
                        );
                      }}
                    >
                      Update cleanup time
                    </Button>
                  </div>
                </Space>
              </>
            )}
            <Divider />
            <Space
              orientation="vertical"
              size="small"
              style={{ width: "100%" }}
            >
              <Typography.Text type="secondary">End the exam</Typography.Text>
              {run.status !== "stopped" && (
                <Typography.Text>
                  {stopHostAtDeadline
                    ? "Erases every student project now, then shuts down the project host."
                    : "Erases every student project now. The project host keeps running."}
                </Typography.Text>
              )}
              {run.status !== "stopped" && (
                <Popconfirm
                  title={
                    stopHostAtDeadline
                      ? "Erase all exam projects and shut down this host?"
                      : "Erase all exam projects now?"
                  }
                  description={
                    stopHostAtDeadline
                      ? "This permanently deletes every temporary exam project, then shuts down the project host."
                      : "This permanently deletes every temporary exam project but leaves the project host running."
                  }
                  okText={stopHostAtDeadline ? "Erase and shut down" : "Erase"}
                  okButtonProps={{ danger: true, disabled: loading }}
                  onConfirm={() =>
                    mutateIdempotently("stop", (idempotency_key) =>
                      api.stopAndEraseHostExamRun({
                        id: host.id,
                        browser_id: webapp_client.browser_id,
                        run_id: run.run_id,
                        stop_host: stopHostAtDeadline,
                        idempotency_key,
                        timeout: EXAM_LIFECYCLE_TIMEOUT_MS,
                      }),
                    )
                  }
                >
                  <Button danger disabled={loading}>
                    End exam and erase now
                  </Button>
                </Popconfirm>
              )}
            </Space>
          </Card>
        )}
        <Button onClick={() => void refresh()}>Refresh status</Button>
      </Space>
      <FreshAuthModal {...freshAuthModalProps} />
    </Spin>
  );
}
