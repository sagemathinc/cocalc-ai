import {
  Alert,
  Button,
  Card,
  Collapse,
  Divider,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popover,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { InfoCircleOutlined } from "@ant-design/icons";
import { alert_message } from "@cocalc/frontend/alerts";
import {
  CSS,
  React,
  useEffect,
  useMemo,
  useState,
  redux,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import type {
  SshSessionRow,
  UpgradeInfoPayload,
} from "@cocalc/conat/hub/api/ssh";
import type {
  ReflectForwardRow,
  ReflectLogRow,
  ReflectSessionLogRow,
  ReflectSessionRow,
} from "@cocalc/conat/hub/api/reflect";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { lite, project_id } from "@cocalc/frontend/lite";

const PAGE_STYLE: CSS = {
  padding: "16px",
  overflow: "auto",
} as const;

const REMOTE_READY_ATTEMPTS = 8;
const REMOTE_READY_TIMEOUT_MS = 7000;
const STATUS_CONCURRENCY = 7;

const TITLE_STYLE: CSS = {
  marginBottom: "12px",
} as const;

type ReflectTargetState = {
  sessions: ReflectSessionRow[];
  forwards: ReflectForwardRow[];
  loading: boolean;
  error: string | null;
};

function statusTag(status?: string) {
  const value = status ?? "unknown";
  if (value === "running") return <Tag color="green">running</Tag>;
  if (value === "stopped") return <Tag color="default">stopped</Tag>;
  if (value === "missing") return <Tag color="orange">missing</Tag>;
  if (value === "unreachable") return <Tag color="red">unreachable</Tag>;
  if (value === "error") return <Tag color="red">error</Tag>;
  return <Tag>{value}</Tag>;
}

function syncStateDisplay(row: ReflectSessionRow) {
  const desired = row.desired_state || "unknown";
  const actual = row.actual_state || "unknown";
  if (desired === actual) {
    return <Space size={6}>{reflectStateTag(actual)}</Space>;
  }
  return (
    <Space size={6}>
      {reflectStateTag(desired)}
      <Typography.Text type="secondary">→</Typography.Text>
      {reflectStateTag(actual)}
    </Space>
  );
}

function tunnelTag(active?: boolean) {
  if (active) return <Tag color="blue">active</Tag>;
  return <Tag>idle</Tag>;
}

function reflectStateTag(state?: string) {
  if (!state) return <Tag>unknown</Tag>;
  if (state === "running") return <Tag color="green">running</Tag>;
  if (state === "stopped") return <Tag color="default">stopped</Tag>;
  if (state === "error") return <Tag color="red">error</Tag>;
  return <Tag>{state}</Tag>;
}

function formatForwardLocal(fwd: ReflectForwardRow) {
  return `${fwd.local_host}:${fwd.local_port}`;
}

function formatForwardRemote(fwd: ReflectForwardRow, target?: string) {
  const host = target || fwd.ssh_host || fwd.remote_host || "remote";
  const endpoint = `${host}:${fwd.remote_port}`;
  if (fwd.ssh_port) {
    return `${endpoint} (ssh:${fwd.ssh_port})`;
  }
  return endpoint;
}

function normalizeSyncPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  if (trimmed === "~") return "";
  if (trimmed.startsWith("~/")) {
    return trimmed.slice(2);
  }
  const homeMatch = /^(\/(?:home|Users)\/[^/]+)(?:\/(.*))?$/.exec(trimmed);
  if (homeMatch) {
    return homeMatch[2] ?? "";
  }
  return trimmed.replace(/^\/+/, "");
}

function encodePathSegments(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function parseSshTarget(target: string): { host: string; port: number | null } {
  const trimmed = target.trim();
  const match = /^(?:(?<user>[^@]+)@)?(?<host>[^:]+)(?::(?<port>\d+))?$/.exec(
    trimmed,
  );
  if (!match) {
    return { host: trimmed, port: null };
  }
  const user = match.groups?.user;
  const hostPart = match.groups?.host?.trim() ?? "";
  const port = match.groups?.port ? Number(match.groups.port) : null;
  return {
    host: user ? `${user}@${hostPart}` : hostPart,
    port: port ?? null,
  };
}

function normalizePath(input: string) {
  return input.replace(/\/+$/, "") || "/";
}

function pathsOverlap(a: string, b: string) {
  const aNorm = normalizePath(a);
  const bNorm = normalizePath(b);
  if (aNorm === bNorm) return true;
  return aNorm.startsWith(`${bNorm}/`) || bNorm.startsWith(`${aNorm}/`);
}

function filterForwardsByTarget(
  forwards: ReflectForwardRow[],
  target: string,
): ReflectForwardRow[] {
  const { host, port } = parseSshTarget(target);
  const targetHost = host;
  const targetHostNoUser = host.split("@").pop() ?? host;
  return forwards.filter((row) => {
    const rowPort = row.ssh_port ?? null;
    const rowHost = row.ssh_host ?? "";
    const rowHostNoUser = rowHost.split("@").pop() ?? rowHost;
    const hostMatches =
      rowHost === targetHost || rowHostNoUser === targetHostNoUser;
    if (!hostMatches) return false;
    if (port == null) {
      return rowPort == null || rowPort === 22;
    }
    return rowPort === port;
  });
}

function extractIgnoreRules(raw?: string) {
  if (!raw) return [];
  return raw
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseIgnoreRules(raw?: string | null) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => String(entry).trim()).filter(Boolean);
    }
  } catch {
    // fall back to text parsing
  }
  return extractIgnoreRules(raw);
}

export const SshPage: React.FC = React.memo(() => {
  const sshRemoteTarget = useTypedRedux("customize", "ssh_remote_target");
  const activeTopTab = useTypedRedux("page", "active_top_tab");
  const projectMap = useTypedRedux("projects", "project_map");
  const projectColor = projectMap?.getIn([activeTopTab, "color"]) as
    | string
    | undefined;
  const pageStyle = useMemo<CSS>(
    () => ({
      ...PAGE_STYLE,
      borderLeft: projectColor ? `3px solid ${projectColor}` : undefined,
    }),
    [projectColor],
  );
  const [rows, setRows] = useState<SshSessionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [openingTargets, setOpeningTargets] = useState<Record<string, boolean>>(
    {},
  );
  const [openingStatus, setOpeningStatus] = useState<Record<string, string>>(
    {},
  );
  const [statusLoadingTargets, setStatusLoadingTargets] = useState<
    Record<string, boolean>
  >({});
  const [upgradingTargets, setUpgradingTargets] = useState<
    Record<string, boolean>
  >({});
  const [reflectByTarget, setReflectByTarget] = useState<
    Record<string, ReflectTargetState>
  >({});
  const [upgradeInfo, setUpgradeInfo] = useState<UpgradeInfoPayload>({
    remotes: {},
  });
  const [upgradeChecking, setUpgradeChecking] = useState(false);
  const [expandedTargets, setExpandedTargets] = useState<string[]>([]);
  const [reflectModalOpen, setReflectModalOpen] = useState(false);
  const [reflectModalTarget, setReflectModalTarget] = useState<string | null>(
    null,
  );
  const [reflectForm] = Form.useForm();
  const [editSessionTarget, setEditSessionTarget] = useState<string | null>(
    null,
  );
  const [editSessionRow, setEditSessionRow] =
    useState<ReflectSessionRow | null>(null);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editForm] = Form.useForm();
  const [forwardModalOpen, setForwardModalOpen] = useState(false);
  const [forwardModalTarget, setForwardModalTarget] = useState<string | null>(
    null,
  );
  const [forwardForm] = Form.useForm();
  const forwardLocalPort = Form.useWatch("localPort", forwardForm);
  const forwardRemotePort = Form.useWatch("remotePort", forwardForm);
  const [reflectLogModalOpen, setReflectLogModalOpen] = useState(false);
  const [reflectLogRows, setReflectLogRows] = useState<ReflectLogRow[]>([]);
  const [reflectLogLoading, setReflectLogLoading] = useState(false);
  const [reflectLogTitle, setReflectLogTitle] = useState<string>("Logs");
  const [reflectLogError, setReflectLogError] = useState<string | null>(null);
  const [reflectLogTarget, setReflectLogTarget] = useState<string | null>(null);
  const [targetModalOpen, setTargetModalOpen] = useState(false);
  const [targetForm] = Form.useForm();
  const ignoreHelp = (
    <Typography.Text type="secondary">
      Use gitignore-style patterns.{" "}
      <Typography.Link
        href="https://git-scm.com/docs/gitignore"
        target="_blank"
        rel="noreferrer"
      >
        Format reference
      </Typography.Link>
    </Typography.Text>
  );
  const targetHelp = (
    <div style={{ marginTop: 8 }}>
      <Space size={6}>
        <Typography.Text type="secondary">
          [user@]hostname[:port] (port is optional)
        </Typography.Text>
        <Popover
          content={
            <div style={{ maxWidth: 280 }}>
              <Typography.Paragraph style={{ marginBottom: 0 }}>
                We will connect over SSH, ensure CoCalc Plus is installed on the
                remote machine, and start a local tunnel so you can use the
                remote server in your browser.
              </Typography.Paragraph>
            </div>
          }
        >
          <Button
            size="small"
            type="text"
            icon={<InfoCircleOutlined />}
            aria-label="SSH target help"
          />
        </Popover>
      </Space>
    </div>
  );

  if (sshRemoteTarget) {
    return (
      <div style={pageStyle}>
        <Space style={TITLE_STYLE} size={12} align="center">
          {lite && (
            <Button
              size="small"
              onClick={() => {
                redux.getActions("page").set_active_tab(project_id);
              }}
            >
              Back
            </Button>
          )}
          <Typography.Title level={4} style={{ margin: 0 }}>
            Remote SSH Session
          </Typography.Title>
        </Space>
        <Typography.Paragraph>
          SSH session management is disabled in this remote instance.
        </Typography.Paragraph>
        <Typography.Paragraph>
          Target:{" "}
          <Typography.Text code copyable={{ text: sshRemoteTarget }}>
            {sshRemoteTarget}
          </Typography.Text>
        </Typography.Paragraph>
      </div>
    );
  }

  const ensureReflectState = (target: string): ReflectTargetState => {
    return (
      reflectByTarget[target] || {
        sessions: [],
        forwards: [],
        loading: false,
        error: null,
      }
    );
  };

  const loadSessions = async (opts?: {
    background?: boolean;
    refreshStatus?: boolean;
  }) => {
    const background = opts?.background ?? rows.length > 0;
    if (background) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    try {
      const data = await webapp_client.conat_client.hub.ssh.listSessionsUI({
        withStatus: false,
      });
      const nextRows = data || [];
      setRows(nextRows);
      if (opts?.refreshStatus ?? true) {
        void refreshSessionStatus(nextRows.map((row) => row.target));
      }
      const missingUpgradeTargets = nextRows.some(
        (row) => !upgradeInfo.remotes?.[row.target],
      );
      if (missingUpgradeTargets) {
        void loadUpgradeInfo({ scope: "remote" });
      }
    } catch (err: any) {
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    } finally {
      if (background) {
        setRefreshing(false);
      } else {
        setLoading(false);
      }
    }
  };

  const loadUpgradeInfo = async (opts?: {
    force?: boolean;
    scope?: "local" | "remote" | "all";
  }) => {
    setUpgradeChecking(true);
    try {
      const data = await webapp_client.conat_client.hub.ssh.getUpgradeInfoUI({
        force: opts?.force,
        scope: opts?.scope,
      });
      if (data) {
        setUpgradeInfo((prev) => ({
          local: data.local ?? prev.local,
          remotes: {
            ...prev.remotes,
            ...(data.remotes || {}),
          },
        }));
        if (data.local && typeof window !== "undefined") {
          try {
            window.localStorage.setItem(
              "cocalc-plus-upgrade-info",
              JSON.stringify(data.local),
            );
            window.dispatchEvent(
              new CustomEvent("cocalc-plus-upgrade-info", {
                detail: data.local,
              }),
            );
          } catch {
            // ignore storage errors
          }
        }
      }
    } catch (err: any) {
      // ignore upgrade check failures; surface when requested
    } finally {
      setUpgradeChecking(false);
    }
  };

  const loadReflectForTarget = async (target: string) => {
    setReflectByTarget((prev) => ({
      ...prev,
      [target]: {
        ...ensureReflectState(target),
        loading: true,
        error: null,
      },
    }));
    try {
      const [sessions, forwards] = await Promise.all([
        webapp_client.conat_client.hub.reflect.listSessionsUI({ target }),
        webapp_client.conat_client.hub.reflect.listForwardsUI(),
      ]);
      const filteredForwards = filterForwardsByTarget(
        forwards || [],
        target,
      );
      setReflectByTarget((prev) => ({
        ...prev,
        [target]: {
          sessions: sessions || [],
          forwards: filteredForwards,
          loading: false,
          error: null,
        },
      }));
    } catch (err: any) {
      setReflectByTarget((prev) => ({
        ...prev,
        [target]: {
          ...ensureReflectState(target),
          loading: false,
          error: err?.message || String(err),
        },
      }));
    }
  };

  const handleOpen = async (target: string) => {
    setOpeningTargets((prev) => ({ ...prev, [target]: true }));
    setOpeningStatus((prev) => ({
      ...prev,
      [target]: "Connecting…",
    }));
    try {
      const result = await connectSessionWithRetry(target, {
        onStage: (stage) =>
          setOpeningStatus((prev) => ({
            ...prev,
            [target]: stage,
          })),
      });
      if (result?.url) {
        const localUrl =
          typeof window !== "undefined" ? window.location.href : undefined;
        const windowName = localUrl ? `cocalc|${localUrl}` : undefined;
        window.open(result.url, windowName ?? "_blank", "noopener");
      }
      await loadSessions({ background: true });
    } catch (err: any) {
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    } finally {
      setOpeningTargets((prev) => ({ ...prev, [target]: false }));
      setOpeningStatus((prev) => ({ ...prev, [target]: "" }));
    }
  };

  const handleAddTarget = async () => {
    try {
      const values = await targetForm.validateFields();
      const target = values.target?.trim();
      await webapp_client.conat_client.hub.ssh.addSessionUI({ target });
      setTargetModalOpen(false);
      targetForm.resetFields();
      await loadSessions();
    } catch (err: any) {
      if (err?.errorFields) {
        return;
      }
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    }
  };

  const handleStop = async (target: string) => {
    try {
      await webapp_client.conat_client.hub.ssh.stopSessionUI({ target });
      await loadSessions({ background: true });
    } catch (err: any) {
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    }
  };

  const handleUpgrade = async (target: string) => {
    setUpgradingTargets((prev) => ({ ...prev, [target]: true }));
    setOpeningStatus((prev) => ({ ...prev, [target]: "Upgrading…" }));
    try {
      const localUrl =
        typeof window !== "undefined" ? window.location.href : undefined;
      await webapp_client.conat_client.hub.ssh.upgradeSessionUI({
        target,
        localUrl,
      });
      await loadSessions({ background: true, refreshStatus: true });
      await loadUpgradeInfo({ force: true, scope: "remote" });
      alert_message({
        type: "success",
        message: "Remote server upgraded",
      });
    } catch (err: any) {
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    } finally {
      setUpgradingTargets((prev) => ({ ...prev, [target]: false }));
      setOpeningStatus((prev) => ({ ...prev, [target]: "" }));
    }
  };

  const handleDeleteTarget = async (target: string) => {
    try {
      try {
        const [sessions, forwards] = await Promise.all([
          webapp_client.conat_client.hub.reflect.listSessionsUI({ target }),
          webapp_client.conat_client.hub.reflect.listForwardsUI(),
        ]);
        const filteredForwards = filterForwardsByTarget(
          forwards || [],
          target,
        );
        const results = await Promise.allSettled([
          ...(sessions || []).map((session) =>
            webapp_client.conat_client.hub.reflect.terminateSessionUI({
              idOrName: String(session.id),
            }),
          ),
          ...filteredForwards.map((forward) =>
            webapp_client.conat_client.hub.reflect.terminateForwardUI({
              id: forward.id,
            }),
          ),
        ]);
        const failures = results.filter((r) => r.status === "rejected");
        if (failures.length > 0) {
          alert_message({
            type: "warning",
            message: "Some syncs or forwards could not be removed.",
          });
        }
      } catch (err: any) {
        alert_message({
          type: "warning",
          message:
            err?.message ||
            "Unable to clean up syncs/forwards; removing session anyway.",
        });
      }
      await webapp_client.conat_client.hub.ssh.deleteSessionUI({ target });
      await loadSessions({ background: true });
    } catch (err: any) {
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    }
  };

  const connectSessionWithRetry = async (
    target: string,
    opts?: { onStage?: (stage: string) => void },
  ) => {
    const localUrl =
      typeof window !== "undefined" ? window.location.href : undefined;
    let result;
    for (let attempt = 1; attempt <= REMOTE_READY_ATTEMPTS; attempt += 1) {
      try {
        const stage =
          attempt === 1
            ? "Connecting…"
            : `Waiting for server (${attempt}/${REMOTE_READY_ATTEMPTS})…`;
        opts?.onStage?.(stage);
        result = await webapp_client.conat_client.hub.ssh.connectSessionUI({
          target,
          options: {
            noOpen: true,
            localUrl,
            waitForReady: true,
            readyTimeoutMs: REMOTE_READY_TIMEOUT_MS,
          },
        });
        break;
      } catch (err: any) {
        const message = err?.message || String(err);
        if (
          message.includes("Remote server did not respond in time") &&
          attempt < REMOTE_READY_ATTEMPTS
        ) {
          if (attempt === 1) {
            alert_message({
              type: "info",
              message: "Remote server is still starting — retrying...",
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }
        throw err;
      }
    }
    return result;
  };

  const refreshSessionStatus = async (targets: string[]) => {
    const queue = targets.filter(Boolean);
    const runOne = async (): Promise<void> => {
      const target = queue.shift();
      if (!target) return;
      setStatusLoadingTargets((prev) => ({ ...prev, [target]: true }));
      try {
        const status =
          await webapp_client.conat_client.hub.ssh.statusSessionUI({
            target,
          });
        setRows((prev) =>
          prev.map((row) =>
            row.target === target ? { ...row, status } : row,
          ),
        );
      } catch {
        setRows((prev) =>
          prev.map((row) =>
            row.target === target
              ? { ...row, status: row.status ?? "unreachable" }
              : row,
          ),
        );
      } finally {
        setStatusLoadingTargets((prev) => {
          const next = { ...prev };
          delete next[target];
          return next;
        });
        await runOne();
      }
    };
    const runners = Array.from(
      { length: Math.min(STATUS_CONCURRENCY, queue.length) },
      () => runOne(),
    );
    await Promise.all(runners);
  };

  const openLocalPath = (path: string) => {
    if (!lite || !project_id) return;
    const actions = redux.getProjectActions(project_id);
    if (!actions) return;
    const normalized = normalizeSyncPath(path);
    actions.open_directory(normalized);
    redux.getActions("page").set_active_tab(project_id);
  };

  const openRemotePath = async (target: string, path: string) => {
    setOpeningTargets((prev) => ({ ...prev, [target]: true }));
    setOpeningStatus((prev) => ({
      ...prev,
      [target]: "Connecting…",
    }));
    try {
      const result = await connectSessionWithRetry(target, {
        onStage: (stage) =>
          setOpeningStatus((prev) => ({
            ...prev,
            [target]: stage,
          })),
      });
      if (!result?.url) return;
      const localUrl =
        typeof window !== "undefined" ? window.location.href : undefined;
      const windowName = localUrl ? `cocalc|${localUrl}` : undefined;
      const normalized = normalizeSyncPath(path);
      const encoded = encodePathSegments(normalized);
      const url = new URL(result.url);
      const base = url.pathname.endsWith("/")
        ? url.pathname.slice(0, -1)
        : url.pathname;
      const suffix = encoded ? `/files/${encoded}/` : "/files/";
      url.pathname = `${base}${suffix}`;
      window.open(url.toString(), windowName ?? "_blank", "noopener");
      await loadSessions({ background: true });
    } catch (err: any) {
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    } finally {
      setOpeningTargets((prev) => ({ ...prev, [target]: false }));
      setOpeningStatus((prev) => ({ ...prev, [target]: "" }));
    }
  };

  const handleCreateReflect = async () => {
    if (!reflectModalTarget) return;
    try {
      const values = await reflectForm.validateFields();
      const localPath = values.localPath?.trim();
      const remotePath = values.remotePath?.trim() || undefined;
      const ignoreRules = extractIgnoreRules(values.ignoreRules);
      const prefer = values.prefer;
      await webapp_client.conat_client.hub.reflect.createSessionUI({
        target: reflectModalTarget,
        localPath,
        remotePath,
        prefer,
        useGitignore: values.useGitignore,
        ignore: ignoreRules,
      });
      setReflectModalOpen(false);
      setReflectModalTarget(null);
      reflectForm.resetFields();
      await loadReflectForTarget(reflectModalTarget);
      alert_message({ type: "success", message: "Sync session created" });
    } catch (err: any) {
      if (err?.errorFields) {
        return;
      }
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    }
  };

  const handleCreateForward = async () => {
    if (!forwardModalTarget) return;
    try {
      const values = await forwardForm.validateFields();
      await webapp_client.conat_client.hub.reflect.createForwardUI({
        target: forwardModalTarget,
        localPort: Number(values.localPort),
        remotePort: values.remotePort ? Number(values.remotePort) : undefined,
        direction: "local_to_remote",
        name: values.name || undefined,
      });
      setForwardModalOpen(false);
      setForwardModalTarget(null);
      forwardForm.resetFields();
      await loadReflectForTarget(forwardModalTarget);
      alert_message({ type: "success", message: "Port forward created" });
    } catch (err: any) {
      if (err?.errorFields) {
        return;
      }
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    }
  };

  const handleOpenForward = (port: number) => {
    if (typeof window === "undefined") return;
    window.open(`http://localhost:${port}`, "_blank", "noopener");
  };

  const handleTerminateForward = async (target: string, id: number) => {
    try {
      await webapp_client.conat_client.hub.reflect.terminateForwardUI({ id });
      await loadReflectForTarget(target);
    } catch (err: any) {
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    }
  };

  const handleTerminateSession = async (target: string, id: number) => {
    try {
      await webapp_client.conat_client.hub.reflect.terminateSessionUI({
        idOrName: String(id),
      });
      await loadReflectForTarget(target);
    } catch (err: any) {
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    }
  };

  const handleStopReflectSession = async (target: string, id: number) => {
    try {
      await webapp_client.conat_client.hub.reflect.stopSessionUI({
        idOrName: String(id),
      });
      await loadReflectForTarget(target);
    } catch (err: any) {
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    }
  };

  const handleStartReflectSession = async (target: string, id: number) => {
    try {
      await webapp_client.conat_client.hub.reflect.startSessionUI({
        idOrName: String(id),
      });
      await loadReflectForTarget(target);
    } catch (err: any) {
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    }
  };

  const openEditSession = (target: string, row: ReflectSessionRow) => {
    setEditSessionTarget(target);
    setEditSessionRow(row);
    editForm.setFieldsValue({
      prefer: row.prefer ?? "alpha",
      ignoreRules: parseIgnoreRules(row.ignore_rules).join("\n"),
    });
    setEditModalOpen(true);
  };

  const handleEditSession = async () => {
    if (!editSessionRow || !editSessionTarget) return;
    try {
      const values = await editForm.validateFields();
      const ignoreRules = extractIgnoreRules(values.ignoreRules);
      await webapp_client.conat_client.hub.reflect.editSessionUI({
        idOrName: String(editSessionRow.id),
        prefer: values.prefer,
        ignore: ignoreRules,
      });
      setEditModalOpen(false);
      setEditSessionRow(null);
      setEditSessionTarget(null);
      editForm.resetFields();
      await loadReflectForTarget(editSessionTarget);
      alert_message({ type: "success", message: "Sync updated" });
    } catch (err: any) {
      if (err?.errorFields) {
        return;
      }
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    }
  };

  const formatReflectLogs = (rows: ReflectLogRow[]) => {
    return rows
      .map((row) => {
        const ts = new Date(row.ts).toLocaleString();
        const scope = row.scope ? ` (${row.scope})` : "";
        const meta = row.meta ? ` ${JSON.stringify(row.meta)}` : "";
        return `${ts} [${row.level}]${scope} ${row.message}${meta}`;
      })
      .join("\n");
  };

  const loadSessionLogs = async (row: ReflectSessionRow) => {
    setReflectLogTitle(`Session Logs: ${row.alpha_root}`);
    setReflectLogTarget(String(row.id));
    setReflectLogError(null);
    setReflectLogLoading(true);
    setReflectLogModalOpen(true);
    try {
      const logs = (await webapp_client.conat_client.hub.reflect.listSessionLogsUI(
        {
          idOrName: String(row.id),
          order: "desc",
          limit: 200,
        },
      )) as ReflectSessionLogRow[];
      setReflectLogRows(logs || []);
    } catch (err: any) {
      setReflectLogError(err?.message || String(err));
      setReflectLogRows([]);
    } finally {
      setReflectLogLoading(false);
    }
  };

  const loadDaemonLogs = async () => {
    setReflectLogTitle("Reflect Daemon Logs");
    setReflectLogTarget("daemon");
    setReflectLogError(null);
    setReflectLogLoading(true);
    setReflectLogModalOpen(true);
    try {
      const logs = (await webapp_client.conat_client.hub.reflect.listDaemonLogsUI(
        {
          order: "desc",
          limit: 200,
        },
      )) as ReflectLogRow[];
      setReflectLogRows(logs || []);
    } catch (err: any) {
      setReflectLogError(err?.message || String(err));
      setReflectLogRows([]);
    } finally {
      setReflectLogLoading(false);
    }
  };

  const refreshLogView = async () => {
    if (!reflectLogTarget) return;
    if (reflectLogTarget === "daemon") {
      await loadDaemonLogs();
      return;
    }
    const id = reflectLogTarget;
    const target = Object.keys(reflectByTarget).find((key) =>
      reflectByTarget[key]?.sessions.some((row) => String(row.id) === id),
    );
    if (target) {
      const row = reflectByTarget[target].sessions.find(
        (r) => String(r.id) === id,
      );
      if (row) {
        await loadSessionLogs(row);
      }
    }
  };

  useEffect(() => {
    loadSessions();
    void loadUpgradeInfo();
  }, []);

  useEffect(() => {
    rows.forEach((row) => {
      const state = reflectByTarget[row.target];
      if (!state || (!state.loading && state.forwards.length === 0)) {
        loadReflectForTarget(row.target);
      }
    });
  }, [rows]);

  useEffect(() => {
    if (reflectModalOpen) {
      reflectForm.setFieldsValue({
        prefer: "alpha",
        useGitignore: true,
      });
    }
  }, [reflectModalOpen, reflectForm]);

  useEffect(() => {
    if (forwardModalOpen) {
      forwardForm.setFieldsValue({
        localPort: 8080,
        remotePort: undefined,
      });
    }
  }, [forwardModalOpen, forwardForm]);

  const columns = useMemo<ColumnsType<SshSessionRow>>(
    () => [
      {
        title: "Target",
        dataIndex: "target",
        key: "target",
        render: (value, row) => {
          const opening = !!openingTargets[row.target];
          return (
            <Button
              size="small"
              type="link"
              onClick={() => handleOpen(row.target)}
              loading={opening}
              disabled={opening}
            >
              {value}
            </Button>
          );
        },
      },
      {
        title: "Port",
        dataIndex: "localPort",
        key: "localPort",
        width: 110,
      },
      {
        title: "Port Forwards",
        key: "forwards",
        render: (_, row) => {
          const state = reflectByTarget[row.target];
          if (state?.loading) {
            return "…";
          }
          const forwards = state?.forwards ?? [];
          if (!forwards.length) {
            return "-";
          }
          const text = forwards
            .map((fwd) =>
              fwd.local_port === fwd.remote_port
                ? String(fwd.local_port)
                : `${fwd.local_port}→${fwd.remote_port}`,
            )
            .join(", ");
          return (
            <Button
              size="small"
              type="link"
              onClick={() => {
                setExpandedTargets((prev) => {
                  if (prev.includes(row.target)) return prev;
                  return [...prev, row.target];
                });
                loadReflectForTarget(row.target);
              }}
            >
              {text}
            </Button>
          );
        },
      },
      {
        title: "Syncs",
        key: "syncs",
        render: (_, row) => {
          const state = reflectByTarget[row.target];
          if (state?.loading) {
            return "…";
          }
          const sessions = state?.sessions ?? [];
          if (!sessions.length) {
            return "-";
          }
          const text = sessions
            .map((session) => {
              const path =
                session.alpha_root === session.beta_root
                  ? session.alpha_root
                  : `${session.alpha_root}↔${session.beta_root}`;
              const status = session.actual_state || session.desired_state;
              return status ? `${path} (${status})` : path;
            })
            .join(", ");
          return (
            <Button
              size="small"
              type="link"
              onClick={() => {
                setExpandedTargets((prev) => {
                  if (prev.includes(row.target)) return prev;
                  return [...prev, row.target];
                });
                loadReflectForTarget(row.target);
              }}
            >
              {text}
            </Button>
          );
        },
      },
      {
        title: "Status",
        dataIndex: "status",
        key: "status",
        width: 140,
        render: (_, row) => {
          if (upgradingTargets[row.target]) {
            return (
              <Space size={6}>
                <Spin size="small" />
                <Typography.Text type="secondary">upgrading…</Typography.Text>
              </Space>
            );
          }
          if (openingTargets[row.target]) {
            return (
              <Space size={6}>
                <Spin size="small" />
                <Typography.Text type="secondary">
                  {openingStatus[row.target] || "Starting…"}
                </Typography.Text>
              </Space>
            );
          }
          if (statusLoadingTargets[row.target]) {
            return (
              <Space size={6}>
                <Spin size="small" />
                <Typography.Text type="secondary">checking…</Typography.Text>
              </Space>
            );
          }
          return statusTag(row.status);
        },
      },
      {
        title: "Tunnel",
        dataIndex: "tunnelActive",
        key: "tunnelActive",
        width: 120,
        render: (_, row) => tunnelTag(row.tunnelActive),
      },
      {
        title: "Last Used",
        dataIndex: "lastUsed",
        key: "lastUsed",
      },
      {
        title: "Actions",
        key: "actions",
        width: 200,
        render: (_, row) => {
          const opening = !!openingTargets[row.target];
          const upgrading = !!upgradingTargets[row.target];
          const upgradeAvailable =
            upgradeInfo.remotes?.[row.target]?.upgradeAvailable;
          return (
            <Space>
              <Button
                size="small"
                onClick={() => handleOpen(row.target)}
                loading={opening}
                disabled={opening || upgrading}
              >
                Open
              </Button>
              {row.status === "running" ? (
                <Popconfirm
                  title="Stop this session?"
                  description="This will stop the remote daemon for this target."
                  okText="Stop"
                  cancelText="Cancel"
                  onConfirm={() => handleStop(row.target)}
                >
                  <Button size="small" danger disabled={upgrading}>
                    Stop
                  </Button>
                </Popconfirm>
              ) : null}
              {upgradeAvailable ? (
                <Popconfirm
                  title="Upgrade remote server?"
                  description="This will install the latest cocalc-plus on the remote host. Any running terminals and notebooks will restart."
                  okText="Upgrade"
                  cancelText="Cancel"
                  onConfirm={() => handleUpgrade(row.target)}
                >
                  <Button size="small" disabled={opening || upgrading}>
                    Upgrade
                  </Button>
                </Popconfirm>
              ) : null}
              <Popconfirm
                title="Remove this session?"
                description="Removes this target, and also removes any related syncs and port forwards (no files are deleted)."
                okText="Remove"
                cancelText="Cancel"
                onConfirm={() => handleDeleteTarget(row.target)}
              >
                <Button size="small" disabled={opening || upgrading}>
                  Remove
                </Button>
              </Popconfirm>
            </Space>
          );
        },
      },
    ],
    [
      rows,
      reflectByTarget,
      openingTargets,
      openingStatus,
      statusLoadingTargets,
      upgradingTargets,
      upgradeInfo,
    ],
  );

  const buildReflectSessionColumns = (
    target: string,
  ): ColumnsType<ReflectSessionRow> => [
    {
      title: "Local Path",
      dataIndex: "alpha_root",
      key: "alpha_root",
      render: (val) =>
        lite && project_id ? (
          <Button
            size="small"
            type="link"
            style={{ padding: 0 }}
            onClick={() => openLocalPath(String(val))}
          >
            <Typography.Text code>{val}</Typography.Text>
          </Button>
        ) : (
          <Typography.Text code>{val}</Typography.Text>
        ),
    },
    {
      title: "Remote Path",
      dataIndex: "beta_root",
      key: "beta_root",
      render: (val, row) => (
        <Button
          size="small"
          type="link"
          style={{ padding: 0 }}
          onClick={() => openRemotePath(target, String(val))}
        >
          <Typography.Text code>
            {row.beta_host
              ? `${row.beta_host}${row.beta_port ? `:${row.beta_port}` : ""}:${val}`
              : val}
          </Typography.Text>
        </Button>
      ),
    },
      {
        title: "State",
        key: "state",
        width: 160,
        render: (_, row) => syncStateDisplay(row),
      },
    {
      title: "Last Sync",
      key: "last",
      width: 180,
      render: (_, row) =>
        row.last_clean_sync_at
          ? new Date(row.last_clean_sync_at).toLocaleString()
          : "-",
    },
    {
      title: "Logs",
      key: "logs",
      width: 110,
      render: (_, row) => (
        <Button size="small" onClick={() => loadSessionLogs(row)}>
          Logs
        </Button>
      ),
    },
    {
      title: "Actions",
      key: "actions",
      width: 120,
      render: (_, row) => (
        <Space size={6}>
          {row.actual_state === "running" ? (
            <Popconfirm
              title="Pause this sync?"
              description="This will stop syncing until you resume it."
              okText="Pause"
              cancelText="Cancel"
              onConfirm={() => handleStopReflectSession(target, row.id)}
            >
              <Button size="small">Pause</Button>
            </Popconfirm>
          ) : (
            <Button
              size="small"
              onClick={() => handleStartReflectSession(target, row.id)}
            >
              Start
            </Button>
          )}
          <Button size="small" onClick={() => openEditSession(target, row)}>
            Edit
          </Button>
          <Popconfirm
            title="Delete this sync?"
            description="This will remove the session and its metadata."
            okText="Delete"
            cancelText="Cancel"
            onConfirm={() => handleTerminateSession(target, row.id)}
          >
            <Button size="small" danger>
              Delete
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const expandedRowRender = (row: SshSessionRow) => {
    const state = ensureReflectState(row.target);
    const hasSessions = state.sessions.length > 0;
    const hasForwards = state.forwards.length > 0;
    const forwardColumns: ColumnsType<ReflectForwardRow> = [
      {
        title: "Local",
        key: "local",
        render: (_, fwd) => (
          <Button
            size="small"
            type="link"
            onClick={() => handleOpenForward(fwd.local_port)}
          >
            {formatForwardLocal(fwd)}
          </Button>
        ),
      },
      {
        title: "Remote",
        key: "remote",
        render: (_, fwd) => formatForwardRemote(fwd, row.target),
      },
      {
        title: "State",
        key: "state",
        width: 140,
        render: (_, fwd) => reflectStateTag(fwd.actual_state),
      },
      {
        title: "Actions",
        key: "actions",
        width: 120,
        render: (_, fwd) => (
          <Space size={6}>
            <Button
              size="small"
              onClick={() => {
                if (typeof window === "undefined") return;
                window.open(
                  `http://localhost:${fwd.local_port}`,
                  "_blank",
                  "noopener",
                );
              }}
            >
              Open
            </Button>
            <Popconfirm
              title="Remove this forward?"
              description="This will stop and delete the port forward."
              okText="Remove"
              cancelText="Cancel"
              onConfirm={() => handleTerminateForward(row.target, fwd.id)}
            >
              <Button size="small" danger>
                Remove
              </Button>
            </Popconfirm>
          </Space>
        ),
      },
    ];
    return (
        <div
          style={{
            padding: "16px 16px",
            margin: "16px 16px 20px 56px",
            borderRadius: 10,
            background: "#fbfbfb",
            border: "1px solid #e6e6e6",
            borderLeft: "5px solid #d0d0d0",
            boxShadow: "0 2px 6px rgba(0, 0, 0, 0.04)",
          }}
        >
        <Space style={{ marginBottom: 8 }} size={12} align="center">
          <Typography.Title level={5} style={{ margin: 0 }}>
            Sync
          </Typography.Title>
          <Button
            size="small"
            onClick={() => {
              setReflectModalTarget(row.target);
              setReflectModalOpen(true);
            }}
          >
            New Sync
          </Button>
          <Button
            size="small"
            onClick={() => loadReflectForTarget(row.target)}
            loading={state.loading}
          >
            Refresh
          </Button>
          <Button size="small" onClick={loadDaemonLogs}>
            Logs
          </Button>
        </Space>
        {state.error ? (
          <Alert
            type="warning"
            showIcon
            message="Reflect Sync unavailable"
            description={state.error}
          />
        ) : hasSessions ? (
          <Card size="small" style={{ marginBottom: 16 }}>
            <Table
              rowKey={(r) => r.id}
              columns={buildReflectSessionColumns(row.target)}
              dataSource={state.sessions}
              pagination={false}
              size="small"
            />
          </Card>
        ) : null}
        <Divider style={{ margin: "16px 0" }} />
        <Space style={{ marginBottom: 8 }} size={12} align="center">
          <Typography.Title level={5} style={{ margin: 0 }}>
            Port Forwards
          </Typography.Title>
          <Button
            size="small"
            onClick={() => {
              setForwardModalTarget(row.target);
              setForwardModalOpen(true);
            }}
          >
            New Forward
          </Button>
        </Space>
        {hasForwards ? (
          <Card size="small">
            <Table
              rowKey={(r) => r.id}
              columns={forwardColumns}
              dataSource={state.forwards}
              pagination={false}
              size="small"
            />
          </Card>
        ) : null}
      </div>
    );
  };

  const validateLocalPath = async (_: any, value?: string) => {
    if (!value || !value.trim()) {
      throw new Error("Enter a local path");
    }
    const trimmed = value.trim();
    if (!reflectModalTarget) return;
    if (trimmed.startsWith("/")) {
      const existing = ensureReflectState(reflectModalTarget).sessions;
      for (const row of existing) {
        if (pathsOverlap(trimmed, row.alpha_root)) {
          throw new Error(
            `Local path overlaps existing sync: ${row.alpha_root}`,
          );
        }
      }
    }
  };

  return (
    <div style={pageStyle}>
      <Space style={TITLE_STYLE} size={12} align="center">
        {lite && (
          <Button
            size="small"
            onClick={() => {
              redux.getActions("page").set_active_tab(project_id);
            }}
          >
            Back
          </Button>
        )}
        <Typography.Title level={4} style={{ margin: 0 }}>
          Remote SSH Sessions
        </Typography.Title>
        <Popover
          placement="right"
          content={
            <div style={{ maxWidth: 340 }}>
              <Typography.Paragraph style={{ marginBottom: 8 }}>
                Use this page to connect to any Linux or macOS server you can
                reach over SSH and run CoCalc Plus there. Each session starts a
                remote CoCalc server and opens a local URL via a secure SSH
                tunnel, so everything stays on your machine and the remote host.
              </Typography.Paragraph>
              <Typography.Paragraph style={{ marginBottom: 0 }}>
                You can also enable bidirectional file sync between your local
                folders and the remote server, plus create port forwards that
                make remote services (e.g., web apps) available at
                http://localhost on your computer.
              </Typography.Paragraph>
            </div>
          }
        >
          <Button
            size="small"
            type="text"
            icon={<InfoCircleOutlined />}
            aria-label="About Remote SSH Sessions"
          />
        </Popover>
        <Button size="small" onClick={() => setTargetModalOpen(true)}>
          New Remote Session
        </Button>
        <Button
          size="small"
          onClick={() => loadSessions({ background: true })}
          loading={refreshing || loading}
        >
          Refresh
        </Button>
        <Button
          size="small"
          onClick={() => loadUpgradeInfo({ force: true, scope: "all" })}
          loading={upgradeChecking}
        >
          Check for Upgrades
        </Button>
      </Space>
      <Table
        rowKey={(row) => row.target}
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={false}
        size="small"
        expandable={{
          expandedRowRender,
          expandedRowKeys: expandedTargets,
          onExpand: (expanded, record) => {
            setExpandedTargets((prev) => {
              const next = expanded
                ? [...prev, record.target]
                : prev.filter((t) => t !== record.target);
              return Array.from(new Set(next));
            });
            if (expanded) {
              loadReflectForTarget(record.target);
            }
          },
        }}
      />

      <Modal
        title={
          reflectModalTarget
            ? `New Sync for ${reflectModalTarget}`
            : "New Sync"
        }
        open={reflectModalOpen}
        onOk={handleCreateReflect}
        onCancel={() => {
          setReflectModalOpen(false);
          setReflectModalTarget(null);
        }}
        okText="Create"
      >
        <Form
          form={reflectForm}
          layout="vertical"
          initialValues={{ useGitignore: true, prefer: "alpha" }}
        >
          <Form.Item
            label="Local path"
            name="localPath"
            rules={[{ validator: validateLocalPath }]}
          >
            <Input placeholder="~/project or /home/user/project" />
          </Form.Item>
          <Collapse
            size="small"
            items={[
              {
                key: "advanced",
                label: "Advanced",
                children: (
                  <>
                    <Form.Item
                      label="Remote path (defaults to local path)"
                      name="remotePath"
                    >
                      <Input placeholder="~/project" />
                    </Form.Item>
                    <Form.Item
                      label="Conflict preference"
                      name="prefer"
                    >
                      <Select
                        options={[
                          {
                            value: "alpha",
                            label: "Prefer local (alpha)",
                          },
                          {
                            value: "beta",
                            label: "Prefer remote (beta)",
                          },
                        ]}
                      />
                    </Form.Item>
                    <Form.Item
                      label="Use .gitignore (if present)"
                      name="useGitignore"
                      valuePropName="checked"
                    >
                      <Switch />
                    </Form.Item>
                    <Form.Item
                      label="Additional ignore patterns"
                      name="ignoreRules"
                      extra={ignoreHelp}
                    >
                      <Input.TextArea
                        autoSize={{ minRows: 3, maxRows: 6 }}
                        placeholder="node_modules\n*.log"
                      />
                    </Form.Item>
                  </>
                ),
              },
            ]}
          />
        </Form>
      </Modal>

      <Modal
        title="New Remote Session"
        open={targetModalOpen}
        onOk={handleAddTarget}
        onCancel={() => setTargetModalOpen(false)}
        okText="Create"
      >
        <Form form={targetForm} layout="vertical">
          <Form.Item
            label="SSH target"
            name="target"
            rules={[
              { required: true, message: "Enter a target like user@host:22" },
            ]}
            extra={targetHelp}
          >
            <Input placeholder="user@host:22" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={
          editSessionTarget
            ? `Edit Sync for ${editSessionTarget}`
            : "Edit Sync"
        }
        open={editModalOpen}
        onOk={handleEditSession}
        onCancel={() => {
          setEditModalOpen(false);
          setEditSessionRow(null);
          setEditSessionTarget(null);
        }}
        okText="Save"
      >
        <Form form={editForm} layout="vertical">
          <Form.Item label="Conflict preference" name="prefer">
            <Select
              options={[
                { value: "alpha", label: "Prefer local (alpha)" },
                { value: "beta", label: "Prefer remote (beta)" },
              ]}
            />
          </Form.Item>
          <Form.Item
            label="Additional ignore patterns"
            name="ignoreRules"
            extra={ignoreHelp}
          >
            <Input.TextArea
              autoSize={{ minRows: 3, maxRows: 6 }}
              placeholder="node_modules\n*.log"
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={
          forwardModalTarget
            ? `New Forward for ${forwardModalTarget}`
            : "New Forward"
        }
        open={forwardModalOpen}
        onOk={handleCreateForward}
        onCancel={() => {
          setForwardModalOpen(false);
          setForwardModalTarget(null);
        }}
        okText="Create"
      >
        <Form form={forwardForm} layout="vertical">
          {(() => {
            const localPort =
              typeof forwardLocalPort === "number" && forwardLocalPort > 0
                ? forwardLocalPort
                : 8080;
            const remotePort =
              typeof forwardRemotePort === "number" && forwardRemotePort > 0
                ? forwardRemotePort
                : localPort;
            const target = forwardModalTarget ?? "remote host";
            const message =
              `Make it so a remote server listening on port ${remotePort} at ` +
              `${target} is available as http://localhost:${localPort}.`;
            return (
              <>
                <Alert
                  type="info"
                  showIcon
                  message={message}
                  style={{ marginBottom: 12 }}
                />
              </>
            );
          })()}
          <Form.Item
            label="Local port"
            name="localPort"
            rules={[{ required: true, message: "Enter a local port" }]}
          >
            <InputNumber min={1} max={65535} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="Remote port (defaults to local port)" name="remotePort">
            <InputNumber min={1} max={65535} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="Name (optional)" name="name">
            <Input placeholder="my-forward" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={reflectLogTitle}
        open={reflectLogModalOpen}
        onCancel={() => setReflectLogModalOpen(false)}
        footer={[
          <Button key="refresh" onClick={refreshLogView} loading={reflectLogLoading}>
            Refresh
          </Button>,
          <Button key="close" onClick={() => setReflectLogModalOpen(false)}>
            Close
          </Button>,
        ]}
      >
        {reflectLogError ? (
          <Alert
            type="warning"
            showIcon
            message="Unable to load logs"
            description={reflectLogError}
          />
        ) : reflectLogLoading ? (
          <Space size={8} align="center">
            <Spin size="small" />
            <Typography.Text type="secondary">Loading logs…</Typography.Text>
          </Space>
        ) : reflectLogRows.length === 0 ? (
          <Empty
            description="No daemon logs yet"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : (
          <Input.TextArea
            value={formatReflectLogs(reflectLogRows)}
            readOnly
            autoSize={{ minRows: 8, maxRows: 16 }}
          />
        )}
      </Modal>
    </div>
  );
});
