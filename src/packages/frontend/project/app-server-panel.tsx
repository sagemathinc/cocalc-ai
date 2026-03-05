/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Checkbox, Divider, Input, Modal, Popconfirm, Select, Space, Spin, Tag } from "antd";
import type {
  AppSpec,
  AppPublicReadinessAudit,
  DetectedAppPort,
  ManagedAppStatus,
} from "@cocalc/conat/project/api/apps";
import { Paragraph } from "@cocalc/frontend/components";
import ShowError from "@cocalc/frontend/components/error";
import {
  dispatchNavigatorPromptIntent,
  submitNavigatorPromptToCurrentThread,
} from "@cocalc/frontend/project/new/navigator-intents";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { withProjectHostBase } from "./host-url";

type AppKind = "service" | "static";
type PresetKind = "service" | "static";

interface AppServerPreset {
  key: string;
  label: string;
  kind: PresetKind;
  id: string;
  title: string;
  command?: string;
  preferredPort?: string;
  healthPath?: string;
  staticRoot?: string;
  staticIndex?: string;
  staticCacheControl?: string;
  staticRefreshCommand?: string;
  staticRefreshStaleAfter?: string;
  staticRefreshTimeout?: string;
  staticRefreshOnHit?: boolean;
  note?: string;
}

interface StartupFailureDetails {
  appId: string;
  action: "start" | "start-after-save";
  errorMessage: string;
  stdoutTail?: string;
  stderrTail?: string;
}

function normalizeError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(`${err}`);
}

function defaultBasePath(appId: string): string {
  const id = `${appId ?? ""}`.trim();
  return id ? `/apps/${id}` : "/apps/my-app";
}

function joinPath(head: string, tail: string): string {
  const h = `${head ?? ""}`.replace(/\/+$/, "");
  const t = `${tail ?? ""}`.replace(/^\/+/, "");
  return `${h}/${t}`;
}

function tailLines(text: string, maxLines = 30, maxChars = 4000): string {
  const raw = `${text ?? ""}`.trimEnd();
  if (!raw) return "";
  const lines = raw.split("\n");
  const tail = lines.slice(-maxLines).join("\n");
  if (tail.length <= maxChars) return tail;
  return `...${tail.slice(tail.length - maxChars)}`;
}

function isPositiveIntegerText(value: string): boolean {
  const text = `${value ?? ""}`.trim();
  if (!text) return false;
  const n = Number(text);
  return Number.isInteger(n) && n > 0;
}

function appServerPresets(homeDirectory: string): AppServerPreset[] {
  return [
    {
      key: "jupyterlab",
      label: "JupyterLab",
      kind: "service",
      id: "jupyterlab",
      title: "JupyterLab",
      preferredPort: "6002",
      healthPath: "/lab",
      command:
        "jupyter lab --allow-root --port-retries=0 --no-browser --NotebookApp.token= --NotebookApp.password= --ServerApp.disable_check_xsrf=True --NotebookApp.allow_remote_access=True --NotebookApp.mathjax_url=/cdn/mathjax/MathJax.js --NotebookApp.base_url=$APP_BASE_URL --ip=${HOST:-127.0.0.1} --port=${PORT}",
    },
    {
      key: "code-server",
      label: "code-server",
      kind: "service",
      id: "code-server",
      title: "code-server",
      preferredPort: "6004",
      command:
        "code-server --bind-addr=${HOST:-127.0.0.1}:${PORT} --auth=none",
    },
    {
      key: "pluto",
      label: "Pluto",
      kind: "service",
      id: "pluto",
      title: "Pluto",
      preferredPort: "6005",
      command:
        "julia -e 'import Pluto; Pluto.run(launch_browser=false, require_secret_for_access=false, host=get(ENV,\"HOST\",\"127.0.0.1\"), port=parse(Int, ENV[\"PORT\"]))'",
    },
    {
      key: "rstudio",
      label: "RStudio / rserver",
      kind: "service",
      id: "rserver",
      title: "RStudio Server",
      preferredPort: "6006",
      command:
        "rserver --server-daemonize=0 --auth-none=1 --auth-encrypt-password=0 --www-port=${PORT} --www-root-path=${APP_BASE_URL} --auth-minimum-user-id=0",
    },
    {
      key: "python-hello",
      label: "Python Hello World",
      kind: "service",
      id: "python-hello",
      title: "Python Hello World",
      preferredPort: "8080",
      healthPath: "/",
      command:
        "python3 -c \"import os, pathlib, http.server; host=os.getenv('HOST','127.0.0.1'); port=int(os.getenv('PORT','8080')); root=pathlib.Path('/tmp/cocalc-python-hello'); root.mkdir(parents=True, exist_ok=True); (root/'index.html').write_text('<h1>Hello from Python</h1>\\\\n', encoding='utf-8'); os.chdir(root); server=http.server.ThreadingHTTPServer((host,port), http.server.SimpleHTTPRequestHandler); print(f'listening on http://{host}:{port}', flush=True); server.serve_forever()\"",
    },
    {
      key: "node-hello",
      label: "Node.js Hello World",
      kind: "service",
      id: "node-hello",
      title: "Node.js Hello World",
      preferredPort: "8080",
      command:
        "node -e \"const http=require('http');const host=process.env.HOST||'127.0.0.1';const port=Number(process.env.PORT||8080);http.createServer((req,res)=>{const body='hello from node\\\\n';res.writeHead(200,{'content-type':'text/plain; charset=utf-8','content-length':Buffer.byteLength(body)});res.end(body);}).listen(port,host,()=>console.log('listening on http://'+host+':'+port));\"",
    },
    {
      key: "static-hello",
      label: "Static Hello World",
      kind: "static",
      id: "static-hello",
      title: "Static Hello World",
      staticRoot: joinPath(homeDirectory, "static-hello"),
      staticIndex: "index.html",
      staticCacheControl: "public,max-age=3600",
      staticRefreshCommand:
        "mkdir -p \"$APP_STATIC_ROOT\" && [ -f \"$APP_STATIC_ROOT/index.html\" ] || printf '<h1>Hello from static app</h1>\\n' > \"$APP_STATIC_ROOT/index.html\"",
      staticRefreshStaleAfter: "3600",
      staticRefreshTimeout: "120",
      staticRefreshOnHit: true,
      note:
        "Optional refresh job can bootstrap or periodically update generated static content on first/stale hits.",
    },
  ];
}

export function AppServerPanel({
  project_id,
}: {
  project_id: string;
}) {
  const homeDirectory = useMemo(
    () => getProjectHomeDirectory(project_id),
    [project_id],
  );
  const presets = useMemo(
    () => appServerPresets(homeDirectory),
    [homeDirectory],
  );
  const api = useMemo(
    () => webapp_client.conat_client.projectApi({ project_id }),
    [project_id],
  );
  const [presetKey, setPresetKey] = useState<string>("");
  const [kind, setKind] = useState<AppKind>("service");
  const [appId, setAppId] = useState<string>("");
  const [title, setTitle] = useState<string>("");
  const [basePath, setBasePath] = useState<string>("");
  const [command, setCommand] = useState<string>("");
  const [port, setPort] = useState<string>("");
  const [healthPath, setHealthPath] = useState<string>("");
  const [staticRoot, setStaticRoot] = useState<string>("");
  const [staticIndex, setStaticIndex] = useState<string>("index.html");
  const [staticCacheControl, setStaticCacheControl] = useState<string>(
    "public,max-age=3600",
  );
  const [staticRefreshCommand, setStaticRefreshCommand] = useState<string>("");
  const [staticRefreshStaleAfter, setStaticRefreshStaleAfter] =
    useState<string>("3600");
  const [staticRefreshTimeout, setStaticRefreshTimeout] =
    useState<string>("120");
  const [staticRefreshOnHit, setStaticRefreshOnHit] = useState<boolean>(true);
  const [startNow, setStartNow] = useState<boolean>(true);
  const [openWhenReady, setOpenWhenReady] = useState<boolean>(true);
  const [exposeTtlHours, setExposeTtlHours] = useState<string>("24");
  const [exposeAuthFront, setExposeAuthFront] = useState<"none" | "token">(
    "none",
  );
  const [exposeRandomSubdomain, setExposeRandomSubdomain] =
    useState<boolean>(true);
  const [exposeSubdomainLabel, setExposeSubdomainLabel] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [formSubmitting, setFormSubmitting] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submittingToAgent, setSubmittingToAgent] = useState<boolean>(false);
  const [actionAppId, setActionAppId] = useState<string>("");
  const [error, setError] = useState<Error | undefined>(undefined);
  const [audit, setAudit] = useState<AppPublicReadinessAudit | undefined>(
    undefined,
  );
  const [detected, setDetected] = useState<DetectedAppPort[]>([]);
  const [detecting, setDetecting] = useState<boolean>(false);
  const [logsOpen, setLogsOpen] = useState<boolean>(false);
  const [logsLoading, setLogsLoading] = useState<boolean>(false);
  const [logsData, setLogsData] = useState<{
    id: string;
    state: "running" | "stopped";
    stdout: string;
    stderr: string;
  } | null>(null);
  const [specById, setSpecById] = useState<Record<string, AppSpec | undefined>>(
    {},
  );
  const [editSpecOpen, setEditSpecOpen] = useState<boolean>(false);
  const [editSpecLoading, setEditSpecLoading] = useState<boolean>(false);
  const [editSpecSaving, setEditSpecSaving] = useState<boolean>(false);
  const [editSpecTargetId, setEditSpecTargetId] = useState<string>("");
  const [editSpecRaw, setEditSpecRaw] = useState<string>("");
  const [editSpecError, setEditSpecError] = useState<string>("");
  const [startupFailure, setStartupFailure] =
    useState<StartupFailureDetails | undefined>(undefined);
  const [rows, setRows] = useState<ManagedAppStatus[]>([]);

  const activePreset = useMemo(
    () => presets.find((preset) => preset.key === presetKey),
    [presets, presetKey],
  );

  const canSaveForm = useMemo(() => {
    const id = `${appId ?? ""}`.trim();
    if (!id) return false;
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,63})$/i.test(id)) return false;
    if (kind === "service") {
      const cmd = `${command ?? ""}`.trim();
      if (!cmd) return false;
      const portText = `${port ?? ""}`.trim();
      if (portText && !isPositiveIntegerText(portText)) return false;
      return true;
    }
    const root = `${staticRoot ?? ""}`.trim();
    if (!root) return false;
    const refreshCmd = `${staticRefreshCommand ?? ""}`.trim();
    if (refreshCmd) {
      const staleText = `${staticRefreshStaleAfter ?? ""}`.trim();
      const timeoutText = `${staticRefreshTimeout ?? ""}`.trim();
      if (staleText && !isPositiveIntegerText(staleText)) return false;
      if (timeoutText && !isPositiveIntegerText(timeoutText)) return false;
    }
    return true;
  }, [
    appId,
    command,
    kind,
    port,
    staticRefreshCommand,
    staticRefreshStaleAfter,
    staticRefreshTimeout,
    staticRoot,
  ]);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const [next, specRecords] = await Promise.all([
        api.apps.listAppStatuses(),
        api.apps.listAppSpecs(),
      ]);
      setRows(next.sort((a, b) => a.id.localeCompare(b.id)));
      const map: Record<string, AppSpec | undefined> = {};
      for (const row of specRecords) {
        if (row.spec?.id) {
          map[row.spec.id] = row.spec;
        }
      }
      setSpecById(map);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function applyPreset(nextKey: string) {
    const preset = presets.find((x) => x.key === nextKey);
    if (!preset) return;
    setPresetKey(nextKey);
    setKind(preset.kind);
    setAppId(preset.id);
    setTitle(preset.title);
    setBasePath(defaultBasePath(preset.id));
    if (preset.kind === "service") {
      setCommand(preset.command ?? "");
      setPort(preset.preferredPort ?? "");
      setHealthPath(preset.healthPath ?? "");
      setStartNow(true);
      setOpenWhenReady(true);
    } else {
      setStaticRoot(preset.staticRoot ?? "");
      setStaticIndex(preset.staticIndex ?? "index.html");
      setStaticCacheControl(
        preset.staticCacheControl ?? "public,max-age=3600",
      );
      setStaticRefreshCommand(preset.staticRefreshCommand ?? "");
      setStaticRefreshStaleAfter(preset.staticRefreshStaleAfter ?? "3600");
      setStaticRefreshTimeout(preset.staticRefreshTimeout ?? "120");
      setStaticRefreshOnHit(preset.staticRefreshOnHit ?? true);
      setStartNow(false);
      setOpenWhenReady(false);
    }
  }

  async function openStatus(status: ManagedAppStatus) {
    let url = status.exposure?.public_url;
    if (!url && status.url) {
      const local = withProjectHostBase(project_id, status.url) ?? status.url;
      url = await webapp_client.conat_client.addProjectHostAuthToUrl({
        project_id,
        url: local,
      });
    }
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function buildSpec() {
    const id = `${appId ?? ""}`.trim();
    if (!id) {
      throw new Error("App ID is required.");
    }
    const specTitle = `${title ?? ""}`.trim() || undefined;
    const proxyPath = `${basePath ?? ""}`.trim() || defaultBasePath(id);
    if (kind === "service") {
      const commandText = `${command ?? ""}`.trim();
      if (!commandText) {
        throw new Error("Command is required for service apps.");
      }
      const parsedPort = `${port ?? ""}`.trim() ? Number(port) : undefined;
      if (parsedPort != null && (!Number.isInteger(parsedPort) || parsedPort <= 0)) {
        throw new Error("Port must be a positive integer.");
      }
      return {
        version: 1 as const,
        id,
        title: specTitle,
        kind: "service" as const,
        command: {
          exec: "bash",
          args: ["-lc", commandText],
        },
        network: {
          listen_host: "127.0.0.1",
          port: parsedPort,
          protocol: "http" as const,
        },
        proxy: {
          base_path: proxyPath,
          strip_prefix: true,
          websocket: true,
          health_path: `${healthPath ?? ""}`.trim() || undefined,
          readiness_timeout_s: 45,
        },
        wake: {
          enabled: true,
          keep_warm_s: 1800,
          startup_timeout_s: 120,
        },
      };
    }
    const root = `${staticRoot ?? ""}`.trim();
    if (!root) {
      throw new Error("Static root path is required.");
    }
    const refreshCommand = `${staticRefreshCommand ?? ""}`.trim();
    const refreshStaleAfter =
      `${staticRefreshStaleAfter ?? ""}`.trim().length > 0
        ? Number(staticRefreshStaleAfter)
        : undefined;
    const refreshTimeout =
      `${staticRefreshTimeout ?? ""}`.trim().length > 0
        ? Number(staticRefreshTimeout)
        : undefined;
    if (refreshCommand) {
      if (
        refreshStaleAfter != null &&
        (!Number.isInteger(refreshStaleAfter) || refreshStaleAfter <= 0)
      ) {
        throw new Error("Static refresh stale-after must be a positive integer.");
      }
      if (
        refreshTimeout != null &&
        (!Number.isInteger(refreshTimeout) || refreshTimeout <= 0)
      ) {
        throw new Error("Static refresh timeout must be a positive integer.");
      }
    }
    return {
      version: 1 as const,
      id,
      title: specTitle,
      kind: "static" as const,
      static: {
        root,
        index: `${staticIndex ?? ""}`.trim() || undefined,
        cache_control: `${staticCacheControl ?? ""}`.trim() || undefined,
        refresh: refreshCommand
          ? {
              command: {
                exec: "bash",
                args: ["-lc", refreshCommand],
              },
              stale_after_s: refreshStaleAfter ?? 3600,
              timeout_s: refreshTimeout ?? 120,
              trigger_on_hit: staticRefreshOnHit,
            }
          : undefined,
      },
      proxy: {
        base_path: proxyPath,
        strip_prefix: true,
        websocket: false,
        readiness_timeout_s: 45,
      },
      wake: {
        enabled: false,
        keep_warm_s: 0,
        startup_timeout_s: 0,
      },
    };
  }

  async function onCreate() {
    let createdId: string | undefined;
    const creatingService = kind === "service" && startNow;
    try {
      setFormSubmitting(true);
      setError(undefined);
      setStartupFailure(undefined);
      const spec = buildSpec();
      const { id } = await api.apps.upsertAppSpec(spec);
      createdId = id;
      let status = await api.apps.statusApp(id);
      if (startNow && spec.kind === "service") {
        status = await api.apps.ensureRunning(id, { timeout: 90_000, interval: 1000 });
      }
      await refresh();
      if (openWhenReady && status.state === "running") {
        await openStatus(status);
      }
    } catch (err) {
      if (creatingService && createdId) {
        await reportStartupFailure({
          appId: createdId,
          action: "start-after-save",
          err,
        });
      } else {
        setError(normalizeError(err));
      }
    } finally {
      setFormSubmitting(false);
    }
  }

  async function onStart(id: string) {
    try {
      setSubmitting(true);
      setError(undefined);
      setStartupFailure(undefined);
      await api.apps.ensureRunning(id, { timeout: 90_000, interval: 1000 });
      await refresh();
    } catch (err) {
      await reportStartupFailure({
        appId: id,
        action: "start",
        err,
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function onStop(id: string) {
    try {
      setSubmitting(true);
      setError(undefined);
      await api.apps.stopApp(id);
      await refresh();
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete(id: string) {
    try {
      setSubmitting(true);
      setError(undefined);
      await api.apps.deleteApp(id);
      await refresh();
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onExpose(id: string) {
    try {
      setSubmitting(true);
      setActionAppId(id);
      setError(undefined);
      const ttl = Math.max(
        60,
        Math.floor((Number(exposeTtlHours) || 24) * 3600),
      );
      await api.apps.exposeApp({
        id,
        ttl_s: ttl,
        auth_front: exposeAuthFront,
        random_subdomain: exposeRandomSubdomain,
        subdomain_label: exposeRandomSubdomain
          ? undefined
          : `${exposeSubdomainLabel ?? ""}`.trim() || undefined,
      });
      await refresh();
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setSubmitting(false);
      setActionAppId("");
    }
  }

  async function onUnexpose(id: string) {
    try {
      setSubmitting(true);
      setActionAppId(id);
      setError(undefined);
      await api.apps.unexposeApp(id);
      await refresh();
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setSubmitting(false);
      setActionAppId("");
    }
  }

  async function onAudit(id: string) {
    try {
      setSubmitting(true);
      setActionAppId(id);
      setError(undefined);
      const next = await api.apps.auditAppPublicReadiness(id);
      setAudit(next);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setSubmitting(false);
      setActionAppId("");
    }
  }

  async function sendAuditToAgent(prompt: string) {
    const text = `${prompt ?? ""}`.trim();
    if (!text) return;
    try {
      setSubmittingToAgent(true);
      const sent = await submitNavigatorPromptToCurrentThread({
        project_id,
        prompt: text,
        tag: "intent:app-server-audit",
        forceCodex: true,
        openFloating: true,
      });
      if (!sent) {
        dispatchNavigatorPromptIntent({
          prompt: text,
          tag: "intent:app-server-audit",
          forceCodex: true,
        });
      }
    } finally {
      setSubmittingToAgent(false);
    }
  }

  async function onDetect() {
    try {
      setDetecting(true);
      setError(undefined);
      const next = await api.apps.detectApps({
        include_managed: true,
        limit: 100,
      });
      setDetected(next);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setDetecting(false);
    }
  }

  function useDetectedPort(portValue: number) {
    setPresetKey("");
    const nextId = `${appId ?? ""}`.trim() || `app-${portValue}`;
    setKind("service");
    setAppId(nextId);
    setTitle((prev) => (prev.trim() ? prev : `Port ${portValue}`));
    setPort(`${portValue}`);
    setBasePath((prev) => (prev.trim() ? prev : defaultBasePath(nextId)));
    setCommand((prev) =>
      prev.trim() ? prev : `python3 -m http.server ${portValue}`,
    );
  }

  async function onLogs(id: string) {
    try {
      setLogsOpen(true);
      setLogsLoading(true);
      setLogsData(null);
      setError(undefined);
      const data = await api.apps.appLogs(id);
      setLogsData(data);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLogsLoading(false);
    }
  }

  async function onEditSpec(id: string) {
    try {
      setEditSpecOpen(true);
      setEditSpecLoading(true);
      setEditSpecError("");
      setEditSpecTargetId(id);
      const spec = await api.apps.getAppSpec(id);
      setEditSpecRaw(`${JSON.stringify(spec, null, 2)}\n`);
    } catch (err) {
      setEditSpecError(`${normalizeError(err).message}`);
    } finally {
      setEditSpecLoading(false);
    }
  }

  async function onSaveSpecEdit() {
    try {
      setEditSpecSaving(true);
      setEditSpecError("");
      const parsed = JSON.parse(editSpecRaw);
      const parsedId = `${parsed?.id ?? ""}`.trim();
      if (!parsedId) {
        throw new Error("Spec must include a non-empty id.");
      }
      if (editSpecTargetId && parsedId !== editSpecTargetId) {
        throw new Error(
          `Editing app '${editSpecTargetId}' only supports keeping the same id. Got '${parsedId}'.`,
        );
      }
      await api.apps.upsertAppSpec(parsed);
      await refresh();
      setEditSpecOpen(false);
      setEditSpecTargetId("");
      setEditSpecRaw("");
    } catch (err) {
      setEditSpecError(`${normalizeError(err).message}`);
    } finally {
      setEditSpecSaving(false);
    }
  }

  function closeEditSpecModal() {
    if (editSpecSaving) return;
    setEditSpecOpen(false);
    setEditSpecLoading(false);
    setEditSpecTargetId("");
    setEditSpecRaw("");
    setEditSpecError("");
  }

  function summarizeSpec(spec: AppSpec | undefined): string[] {
    if (!spec) return [];
    const out: string[] = [];
    const basePath = `${spec?.proxy?.base_path ?? ""}`.trim();
    if (basePath) out.push(`base_path=${basePath}`);
    if (spec.kind === "service") {
      const cmd = spec?.command?.exec
        ? [spec.command.exec, ...(spec.command.args ?? [])].join(" ")
        : "";
      if (cmd) out.push(`command=${cmd}`);
      const configuredPort = spec?.network?.port;
      if (configuredPort) out.push(`port=${configuredPort}`);
      const healthPathValue = `${spec?.proxy?.health_path ?? ""}`.trim();
      if (healthPathValue) out.push(`health=${healthPathValue}`);
    } else if (spec.kind === "static") {
      const root = `${spec?.static?.root ?? ""}`.trim();
      if (root) out.push(`root=${root}`);
      const index = `${spec?.static?.index ?? ""}`.trim();
      if (index) out.push(`index=${index}`);
      const refresh = spec?.static?.refresh;
      if (refresh) {
        out.push(
          `refresh=on-hit stale:${refresh.stale_after_s ?? "?"}s timeout:${refresh.timeout_s ?? "?"}s`,
        );
      }
    }
    return out;
  }

  async function reportStartupFailure({
    appId,
    action,
    err,
  }: {
    appId: string;
    action: "start" | "start-after-save";
    err: unknown;
  }): Promise<void> {
    const base = normalizeError(err);
    try {
      const data = await api.apps.appLogs(appId);
      setLogsData(data);
      setLogsOpen(true);
      setLogsLoading(false);
      setStartupFailure({
        appId,
        action,
        errorMessage: base.message,
        stdoutTail: tailLines(data.stdout),
        stderrTail: tailLines(data.stderr),
      });
    } catch {
      setStartupFailure({
        appId,
        action,
        errorMessage: base.message,
      });
    }
  }

  return (
    <div>
      <Paragraph style={{ color: "#666", marginBottom: "8px" }}>
        Create a managed app server spec, start it, and open the proxied URL.
      </Paragraph>
      <ShowError error={error} setError={() => setError(undefined)} />
      {startupFailure ? (
        <Alert
          type="error"
          showIcon
          closable
          onClose={() => setStartupFailure(undefined)}
          style={{ marginBottom: "10px" }}
          message={`Failed to ${startupFailure.action === "start" ? "start" : "start after save"} app '${startupFailure.appId}'`}
          description={
            <div style={{ display: "grid", gap: "8px" }}>
              <div>{startupFailure.errorMessage}</div>
              <Space wrap>
                <Button
                  size="small"
                  onClick={() => void onLogs(startupFailure.appId)}
                >
                  View full logs
                </Button>
              </Space>
              {startupFailure.stderrTail ? (
                <div>
                  <div style={{ fontWeight: 600, marginBottom: "4px" }}>stderr (tail)</div>
                  <pre
                    style={{
                      margin: 0,
                      maxHeight: "180px",
                      overflow: "auto",
                      border: "1px solid #eee",
                      borderRadius: "6px",
                      padding: "8px",
                      background: "#fff7f7",
                    }}
                  >
                    {startupFailure.stderrTail}
                  </pre>
                </div>
              ) : null}
              {startupFailure.stdoutTail ? (
                <div>
                  <div style={{ fontWeight: 600, marginBottom: "4px" }}>stdout (tail)</div>
                  <pre
                    style={{
                      margin: 0,
                      maxHeight: "180px",
                      overflow: "auto",
                      border: "1px solid #eee",
                      borderRadius: "6px",
                      padding: "8px",
                      background: "#fafafa",
                    }}
                  >
                    {startupFailure.stdoutTail}
                  </pre>
                </div>
              ) : null}
            </div>
          }
        />
      ) : null}
      <Space direction="vertical" style={{ width: "100%" }} size={8}>
        <Select
          value={presetKey || undefined}
          placeholder="Preset (optional)"
          allowClear
          onClear={() => setPresetKey("")}
          onChange={(value) => applyPreset(value)}
          options={presets.map((preset) => ({
            value: preset.key,
            label: preset.label,
          }))}
        />
        {activePreset?.note ? (
          <Alert type="info" showIcon message={activePreset.note} />
        ) : null}
        <Space.Compact style={{ width: "100%" }}>
          <Select<AppKind>
            value={kind}
            style={{ width: "130px" }}
            options={[
              { label: "Service", value: "service" },
              { label: "Static", value: "static" },
            ]}
            onChange={(value) => setKind(value)}
          />
          <Input
            value={appId}
            placeholder="app-id (e.g. streamlit-demo)"
            onChange={(e) => {
              const next = e.target.value;
              const previousDefault = defaultBasePath(appId);
              setAppId(next);
              if (!basePath || basePath === previousDefault) {
                setBasePath(defaultBasePath(next));
              }
            }}
          />
        </Space.Compact>
        <Input
          value={title}
          placeholder="Title (optional)"
          onChange={(e) => setTitle(e.target.value)}
        />
        <Input
          value={basePath}
          placeholder={`/apps/${appId || "my-app"}`}
          onChange={(e) => setBasePath(e.target.value)}
        />
        {kind === "service" ? (
          <>
            <Input
              value={command}
              placeholder="Command (runs as: bash -lc ...)"
              onChange={(e) => setCommand(e.target.value)}
            />
            <Space.Compact style={{ width: "100%" }}>
              <Input
                value={port}
                placeholder="Preferred port (optional)"
                onChange={(e) => setPort(e.target.value)}
              />
              <Input
                value={healthPath}
                placeholder="Health path (optional, e.g. /health)"
                onChange={(e) => setHealthPath(e.target.value)}
              />
            </Space.Compact>
          </>
        ) : (
          <>
            <Input
              value={staticRoot}
              placeholder="Static root path (e.g. /home/user/project/site)"
              onChange={(e) => setStaticRoot(e.target.value)}
            />
            <Space.Compact style={{ width: "100%" }}>
              <Input
                value={staticIndex}
                placeholder="Index file (optional)"
                onChange={(e) => setStaticIndex(e.target.value)}
              />
              <Input
                value={staticCacheControl}
                placeholder="Cache-Control (optional)"
                onChange={(e) => setStaticCacheControl(e.target.value)}
              />
            </Space.Compact>
            <Input
              value={staticRefreshCommand}
              placeholder="Refresh command (optional, runs on first/stale hit)"
              onChange={(e) => setStaticRefreshCommand(e.target.value)}
            />
            <Space.Compact style={{ width: "100%" }}>
              <Input
                value={staticRefreshStaleAfter}
                placeholder="Refresh stale-after seconds (default 3600)"
                onChange={(e) => setStaticRefreshStaleAfter(e.target.value)}
              />
              <Input
                value={staticRefreshTimeout}
                placeholder="Refresh timeout seconds (default 120)"
                onChange={(e) => setStaticRefreshTimeout(e.target.value)}
              />
            </Space.Compact>
            <Checkbox
              checked={staticRefreshOnHit}
              onChange={(e) => setStaticRefreshOnHit(e.target.checked)}
            >
              Trigger refresh on hit when stale
            </Checkbox>
          </>
        )}
        <Space wrap>
          <Checkbox checked={startNow} onChange={(e) => setStartNow(e.target.checked)}>
            Start after save
          </Checkbox>
          <Checkbox
            checked={openWhenReady}
            onChange={(e) => setOpenWhenReady(e.target.checked)}
          >
            Open when ready
          </Checkbox>
          <Button
            type="primary"
            loading={formSubmitting}
            disabled={!canSaveForm}
            onClick={() => void onCreate()}
          >
            Save app
          </Button>
          <Button onClick={() => void refresh()} disabled={loading}>
            Refresh
          </Button>
          <Button onClick={() => void onDetect()} loading={detecting}>
            Detect apps
          </Button>
        </Space>
        <Divider style={{ margin: "8px 0" }} />
        <div style={{ fontWeight: 600 }}>Public expose defaults</div>
        <Space.Compact style={{ width: "100%" }}>
          <Input
            value={exposeTtlHours}
            onChange={(e) => setExposeTtlHours(e.target.value)}
            placeholder="TTL hours (e.g. 24)"
          />
          <Select<"none" | "token">
            value={exposeAuthFront}
            style={{ width: "140px" }}
            options={[
              { label: "No front auth", value: "none" },
              { label: "Token gate", value: "token" },
            ]}
            onChange={(value) => setExposeAuthFront(value)}
          />
        </Space.Compact>
        <Space wrap>
          <Checkbox
            checked={exposeRandomSubdomain}
            onChange={(e) => setExposeRandomSubdomain(e.target.checked)}
          >
            Random subdomain
          </Checkbox>
          {!exposeRandomSubdomain ? (
            <Input
              value={exposeSubdomainLabel}
              onChange={(e) => setExposeSubdomainLabel(e.target.value)}
              placeholder="subdomain label (optional)"
              style={{ width: "220px" }}
            />
          ) : null}
        </Space>
      </Space>
      <Divider style={{ margin: "14px 0" }} />
      {detected.length > 0 ? (
        <>
          <div style={{ fontWeight: 600, marginBottom: "8px" }}>
            Detected listeners
          </div>
          <Space direction="vertical" style={{ width: "100%", marginBottom: "12px" }}>
            {detected.map((item) => (
              <div
                key={`${item.port}-${item.hosts.join(",")}`}
                style={{
                  border: "1px solid #e5e5e5",
                  borderRadius: "8px",
                  padding: "8px 10px",
                  fontSize: "12px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>:{item.port}</div>
                    <div style={{ opacity: 0.8 }}>hosts: {item.hosts.join(", ")}</div>
                    <div style={{ opacity: 0.8 }}>
                      {item.managed
                        ? `managed by ${item.managed_app_ids.join(", ")}`
                        : "not managed"}
                    </div>
                  </div>
                  <Space wrap>
                    <Button
                      size="small"
                      onClick={() => useDetectedPort(item.port)}
                    >
                      Use in form
                    </Button>
                  </Space>
                </div>
              </div>
            ))}
          </Space>
          <Divider style={{ margin: "14px 0" }} />
        </>
      ) : null}
      <div style={{ fontWeight: 600, marginBottom: "8px" }}>Managed app servers</div>
      {loading ? <Spin /> : null}
      {!loading && rows.length === 0 ? (
        <Alert type="info" showIcon message="No managed app servers yet." />
      ) : null}
      <Space direction="vertical" style={{ width: "100%" }}>
        {rows.map((row) => {
          const isRunning = row.state === "running";
          const spec = specById[row.id];
          const specSummary = summarizeSpec(spec);
          return (
            <div
              key={row.id}
              style={{
                border: "1px solid #e5e5e5",
                borderRadius: "8px",
                padding: "8px 10px",
              }}
            >
              <div
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontWeight: 600 }}>{row.title || row.id}</span>
                    <Tag>{row.kind || "service"}</Tag>
                    <Tag color={isRunning ? "green" : "default"}>
                      {isRunning ? "running" : "stopped"}
                    </Tag>
                    {row.exposure?.public_url ? <Tag color="gold">public</Tag> : null}
                  </div>
                  <div style={{ opacity: 0.7, fontFamily: "monospace", fontSize: "12px" }}>
                    {row.id}
                  </div>
                </div>
                <Space wrap>
                  <Button size="small" onClick={() => void openStatus(row)} disabled={!row.url && !row.exposure?.public_url}>
                    Open
                  </Button>
                  <Button
                    size="small"
                    onClick={() => void onStart(row.id)}
                    disabled={submitting || isRunning}
                  >
                    Start
                  </Button>
                  <Button
                    size="small"
                    onClick={() => void onStop(row.id)}
                    disabled={submitting || !isRunning}
                  >
                    Stop
                  </Button>
                  <Popconfirm
                    title="Delete app spec?"
                    description={`Delete '${row.id}' and its managed status.`}
                    okText="Delete"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void onDelete(row.id)}
                  >
                    <Button size="small" danger disabled={submitting}>
                      Delete
                    </Button>
                  </Popconfirm>
                  {row.exposure?.public_url ? (
                    <Button
                      size="small"
                      onClick={() => void onUnexpose(row.id)}
                      loading={submitting && actionAppId === row.id}
                    >
                      Unexpose
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      onClick={() => void onExpose(row.id)}
                      loading={submitting && actionAppId === row.id}
                    >
                      Expose
                    </Button>
                  )}
                  <Button
                    size="small"
                    onClick={() => void onAudit(row.id)}
                    loading={submitting && actionAppId === row.id}
                  >
                    Audit
                  </Button>
                  <Button
                    size="small"
                    onClick={() => void onLogs(row.id)}
                  >
                    Logs
                  </Button>
                  <Button
                    size="small"
                    onClick={() => void onEditSpec(row.id)}
                    disabled={submitting}
                  >
                    Edit spec
                  </Button>
                </Space>
              </div>
              {specSummary.length > 0 ? (
                <div
                  style={{
                    marginTop: "8px",
                    fontSize: "12px",
                    fontFamily: "monospace",
                    opacity: 0.82,
                    display: "grid",
                    gap: "4px",
                  }}
                >
                  {specSummary.map((item) => (
                    <div key={`${row.id}-${item}`}>{item}</div>
                  ))}
                </div>
              ) : null}
              {row.exposure?.public_url ? (
                <div style={{ marginTop: "8px", fontSize: "12px", opacity: 0.85 }}>
                  Public URL:{" "}
                  <a href={row.exposure.public_url} target="_blank" rel="noreferrer">
                    {row.exposure.public_url}
                  </a>
                  {row.exposure?.expires_at_ms ? (
                    <span>
                      {" "}
                      (expires{" "}
                      {new Date(row.exposure.expires_at_ms).toLocaleString()})
                    </span>
                  ) : null}
                </div>
              ) : null}
              {row.warnings?.length ? (
                <Alert
                  style={{ marginTop: "8px" }}
                  type="warning"
                  showIcon
                  message={row.warnings.join(" ")}
                />
              ) : null}
            </div>
          );
        })}
      </Space>
      {audit ? (
        <div
          style={{
            marginTop: "12px",
            border: "1px solid #e5e5e5",
            borderRadius: "8px",
            padding: "10px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
            <div style={{ fontWeight: 600 }}>
              Audit: {audit.title || audit.app_id}
            </div>
            <Button size="small" onClick={() => setAudit(undefined)}>
              Close
            </Button>
          </div>
          <div style={{ marginTop: "6px", fontSize: "12px", opacity: 0.85 }}>
            pass={audit.summary.pass}, warn={audit.summary.warn}, fail={audit.summary.fail}
          </div>
          <ul style={{ marginTop: "8px", marginBottom: "8px", paddingInlineStart: "18px" }}>
            {audit.checks.map((check) => (
              <li key={`${check.id}-${check.status}`}>
                {check.status.toUpperCase()}: {check.message}
              </li>
            ))}
          </ul>
          <Space wrap>
            <Button
              size="small"
              onClick={() =>
                navigator.clipboard.writeText(audit.agent_prompt).catch(() => {})
              }
            >
              Copy Agent Prompt
            </Button>
            <Button
              size="small"
              type="primary"
              loading={submittingToAgent}
              onClick={() => void sendAuditToAgent(audit.agent_prompt)}
            >
              Send to Agent
            </Button>
          </Space>
        </div>
      ) : null}
      <Modal
        open={editSpecOpen}
        onCancel={closeEditSpecModal}
        width={980}
        title={editSpecTargetId ? `Edit spec: ${editSpecTargetId}` : "Edit app spec"}
        destroyOnClose={false}
        footer={[
          <Button key="close" onClick={closeEditSpecModal} disabled={editSpecSaving}>
            Cancel
          </Button>,
          <Button
            key="save"
            type="primary"
            loading={editSpecSaving}
            onClick={() => void onSaveSpecEdit()}
          >
            Save spec
          </Button>,
        ]}
      >
        {editSpecError ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: "8px" }}
            message={editSpecError}
          />
        ) : null}
        {editSpecLoading ? <Spin /> : null}
        {!editSpecLoading ? (
          <Input.TextArea
            value={editSpecRaw}
            onChange={(e) => setEditSpecRaw(e.target.value)}
            autoSize={{ minRows: 16, maxRows: 28 }}
            style={{ fontFamily: "monospace" }}
          />
        ) : null}
      </Modal>
      <Modal
        open={logsOpen}
        onCancel={() => setLogsOpen(false)}
        footer={[
          <Button
            key="refresh"
            onClick={() => {
              if (logsData?.id) {
                void onLogs(logsData.id);
              }
            }}
            disabled={!logsData?.id}
          >
            Refresh
          </Button>,
          <Button key="close" onClick={() => setLogsOpen(false)}>
            Close
          </Button>,
        ]}
        width={980}
        title={logsData ? `App logs: ${logsData.id}` : "App logs"}
      >
        {logsLoading ? <Spin /> : null}
        {!logsLoading && logsData ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "10px",
            }}
          >
            <div>
              <div style={{ fontWeight: 600, marginBottom: "6px" }}>
                stdout
              </div>
              <pre
                style={{
                  margin: 0,
                  maxHeight: "55vh",
                  overflow: "auto",
                  border: "1px solid #eee",
                  borderRadius: "6px",
                  padding: "8px",
                  background: "#fafafa",
                }}
              >
                {logsData.stdout || "(empty)"}
              </pre>
            </div>
            <div>
              <div style={{ fontWeight: 600, marginBottom: "6px" }}>
                stderr
              </div>
              <pre
                style={{
                  margin: 0,
                  maxHeight: "55vh",
                  overflow: "auto",
                  border: "1px solid #eee",
                  borderRadius: "6px",
                  padding: "8px",
                  background: "#fafafa",
                }}
              >
                {logsData.stderr || "(empty)"}
              </pre>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
