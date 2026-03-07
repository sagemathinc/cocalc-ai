/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Divider, Input, Modal, Popconfirm, Select, Space, Spin, Tag } from "antd";
import type {
  AppSpec,
  AppPublicReadinessAudit,
  DetectedAppPort,
  InstalledAppTemplate,
  ManagedAppStatus,
} from "@cocalc/conat/project/api/apps";
import { Paragraph } from "@cocalc/frontend/components";
import ShowError from "@cocalc/frontend/components/error";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import {
  dispatchNavigatorPromptIntent,
  submitNavigatorPromptToCurrentThread,
} from "@cocalc/frontend/project/new/navigator-intents";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { withProjectHostBase } from "./host-url";

type AppKind = "service" | "static";
type PresetKind = "service" | "static";
type AppServiceOpenMode = "proxy" | "port";
type AppStatusFilter = "all" | "running" | "stopped" | "error" | "public";
type AppRowAction = "expose" | "unexpose" | "audit";

interface PublicAppPolicy {
  enabled: boolean;
  dns_domain?: string;
  subdomain_suffix?: string;
}

interface AppServerPreset {
  key: string;
  label: string;
  kind: PresetKind;
  id: string;
  title: string;
  command?: string;
  serviceOpenMode?: AppServiceOpenMode;
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

interface PortableAppSpecBundle {
  version: 1;
  kind: "cocalc-app-spec-bundle";
  exported_at: string;
  workspace_id: string;
  apps: AppSpec[];
  skipped?: Array<{ id: string; path?: string; error: string }>;
}

function normalizeError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(`${err}`);
}

function asPortableSpec(input: unknown, context: string): AppSpec {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${context} must be a JSON object`);
  }
  const id = `${(input as any).id ?? ""}`.trim();
  if (!id) {
    throw new Error(`${context}.id must be a non-empty string`);
  }
  return input as AppSpec;
}

function createPortableBundle(
  projectId: string,
  apps: AppSpec[],
  skipped?: Array<{ id: string; path?: string; error: string }>,
): PortableAppSpecBundle {
  return {
    version: 1,
    kind: "cocalc-app-spec-bundle",
    exported_at: new Date().toISOString(),
    workspace_id: projectId,
    apps,
    skipped: skipped?.length ? skipped : undefined,
  };
}

function parseImportPayload(input: unknown): {
  format: "single" | "bundle";
  apps: AppSpec[];
  sourceWorkspaceId?: string;
} {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Import file must contain a JSON object.");
  }
  const obj = input as Record<string, any>;
  if (Array.isArray(obj.apps)) {
    return {
      format: "bundle",
      apps: obj.apps.map((spec, idx) => asPortableSpec(spec, `apps[${idx}]`)),
      sourceWorkspaceId:
        typeof obj.workspace_id === "string" && obj.workspace_id.trim()
          ? obj.workspace_id.trim()
          : undefined,
    };
  }
  return {
    format: "single",
    apps: [asPortableSpec(obj, "spec")],
  };
}

function downloadJsonFile(filename: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
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

function maxBacktickRun(text: string): number {
  let run = 0;
  let max = 0;
  for (const ch of text) {
    if (ch === "`") {
      run += 1;
      if (run > max) max = run;
    } else {
      run = 0;
    }
  }
  return max;
}

function toFencedCodeBlock(content: string, language = ""): string {
  const text = `${content ?? ""}`;
  const fenceLen = Math.max(3, maxBacktickRun(text) + 1);
  const fence = "`".repeat(fenceLen);
  const info = language.trim();
  return `${fence}${info}\n${text}\n${fence}`;
}

function renderLogTailBlock({
  label,
  content,
  background,
}: {
  label: string;
  content: string;
  background: string;
}) {
  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: "4px" }}>{label}</div>
      <div
        style={{
          maxHeight: "180px",
          overflow: "auto",
          border: "1px solid #eee",
          borderRadius: "6px",
          padding: "8px",
          background,
        }}
      >
        <StaticMarkdown value={toFencedCodeBlock(content, "sh")} />
      </div>
    </div>
  );
}

function isPublicExposure(status: ManagedAppStatus): boolean {
  return status.exposure?.mode === "public";
}

function normalizePublicSuffix(raw?: string): string {
  const value = `${raw ?? ""}`.trim().toLowerCase();
  return value || "app";
}

function currentPublicDnsDomain(): string | undefined {
  if (typeof window === "undefined") return;
  const host = `${window.location.hostname ?? ""}`.trim().toLowerCase();
  if (!host || host === "localhost") return;
  return host;
}

function buildPublicHostnameFromExposure(
  status: ManagedAppStatus,
  policy?: PublicAppPolicy,
): string | undefined {
  const exposure = status.exposure;
  if (exposure?.public_hostname) return exposure.public_hostname;
  const label = `${exposure?.random_subdomain ?? ""}`.trim().toLowerCase();
  const dnsDomain =
    `${policy?.dns_domain ?? ""}`.trim().toLowerCase() ||
    currentPublicDnsDomain();
  if (!label || !dnsDomain) return;
  const suffix = normalizePublicSuffix(policy?.subdomain_suffix);
  return suffix ? `${label}-${suffix}.${dnsDomain}` : `${label}.${dnsDomain}`;
}

function buildPublicUrlFromExposure(
  status: ManagedAppStatus,
  policy?: PublicAppPolicy,
): string | undefined {
  const exposure = status.exposure;
  if (exposure?.public_url) return exposure.public_url;
  const hostname = buildPublicHostnameFromExposure(status, policy);
  return hostname ? `https://${hostname}` : undefined;
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
      serviceOpenMode: "port",
      healthPath: "/lab",
      command:
        "base_url=\"${APP_BASE_URL/\\/proxy\\//\\/port\\/}\"; jupyter lab --allow-root --port-retries=0 --no-browser --NotebookApp.token= --NotebookApp.password= --ServerApp.disable_check_xsrf=True --NotebookApp.allow_remote_access=True --NotebookApp.mathjax_url=/cdn/mathjax/MathJax.js --NotebookApp.base_url=\"${base_url}\" --ServerApp.base_url=\"${base_url}\" --ip=${HOST:-127.0.0.1} --port=${PORT}",
    },
    {
      key: "code-server",
      label: "code-server",
      kind: "service",
      id: "code-server",
      title: "code-server",
      preferredPort: "6004",
      serviceOpenMode: "proxy",
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
      serviceOpenMode: "proxy",
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
      serviceOpenMode: "proxy",
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
      serviceOpenMode: "proxy",
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
      serviceOpenMode: "proxy",
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
  const [serviceOpenMode, setServiceOpenMode] =
    useState<AppServiceOpenMode>("proxy");
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
  const [rowAction, setRowAction] = useState<{
    appId: string;
    action: AppRowAction;
  } | null>(null);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [audit, setAudit] = useState<AppPublicReadinessAudit | undefined>(
    undefined,
  );
  const [detected, setDetected] = useState<DetectedAppPort[]>([]);
  const [detecting, setDetecting] = useState<boolean>(false);
  const [installedTemplates, setInstalledTemplates] = useState<
    InstalledAppTemplate[]
  >([]);
  const [detectingInstalledTemplates, setDetectingInstalledTemplates] =
    useState<boolean>(false);
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
  const [startupFailures, setStartupFailures] = useState<
    Record<string, StartupFailureDetails | undefined>
  >({});
  const [rows, setRows] = useState<ManagedAppStatus[]>([]);
  const [rowFilter, setRowFilter] = useState<AppStatusFilter>("all");
  const [rowSearch, setRowSearch] = useState<string>("");
  const [publicAppPolicy, setPublicAppPolicy] = useState<
    PublicAppPolicy | undefined
  >(undefined);
  const [transferBusy, setTransferBusy] = useState<boolean>(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);

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

  const filteredRows = useMemo(() => {
    const needle = rowSearch.trim().toLowerCase();
    return rows.filter((row) => {
      const spec = specById[row.id];
      const rowHasError =
        !!row.error || !!startupFailures[row.id] || (row.warnings?.length ?? 0) > 0;
      if (rowFilter === "running" && row.state !== "running") return false;
      if (rowFilter === "stopped" && row.state !== "stopped") return false;
      if (rowFilter === "error" && !rowHasError) return false;
      if (rowFilter === "public" && !isPublicExposure(row)) return false;
      if (!needle) return true;
      const haystacks = [
        row.id,
        row.title,
        row.kind,
        row.state,
        row.exposure?.public_url,
        row.exposure?.public_hostname,
        row.exposure?.random_subdomain,
        row.exposure?.mode,
        spec?.proxy?.base_path,
        spec?.static?.root,
      ];
      return haystacks.some((value) =>
        `${value ?? ""}`.toLowerCase().includes(needle),
      );
    });
  }, [rowFilter, rowSearch, rows, specById, startupFailures]);

  useEffect(() => {
    let cancelled = false;
    async function loadPublicAppPolicy() {
      try {
        const policy = await webapp_client.conat_client.hub.system.getProjectAppPublicPolicy(
          { project_id },
        );
        if (!cancelled) {
          setPublicAppPolicy({
            enabled: !!policy?.enabled,
            dns_domain: policy?.dns_domain,
            subdomain_suffix: policy?.subdomain_suffix,
          });
        }
      } catch {
        if (!cancelled) setPublicAppPolicy(undefined);
      }
    }
    void loadPublicAppPolicy();
    return () => {
      cancelled = true;
    };
  }, [project_id]);

  const startableRows = useMemo(
    () => rows.filter((row) => row.kind === "service" && row.state !== "running"),
    [rows],
  );
  const stoppableRows = useMemo(
    () => rows.filter((row) => row.kind === "service" && row.state === "running"),
    [rows],
  );

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      setStartupFailures({});
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
      setServiceOpenMode(preset.serviceOpenMode ?? "proxy");
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
      setServiceOpenMode("proxy");
      setStartNow(false);
      setOpenWhenReady(false);
    }
  }

  async function openStatus(status: ManagedAppStatus) {
    const translateServiceOpenUrl = (
      localUrl: string | undefined,
      mode: AppServiceOpenMode,
    ): string | undefined => {
      if (!localUrl || mode !== "port") return localUrl;
      if (localUrl.includes("/proxy/")) {
        return localUrl.replace("/proxy/", "/port/");
      }
      return localUrl;
    };

    let url = buildPublicUrlFromExposure(status, publicAppPolicy);
    if (!url) {
      let spec = specById[status.id];
      if (!spec) {
        try {
          spec = await api.apps.getAppSpec(status.id);
          setSpecById((prev) => ({ ...prev, [status.id]: spec }));
        } catch {
          // fall back to status.url below
        }
      }
      const declaredBasePath = `${spec?.proxy?.base_path ?? ""}`.trim();
      const basePathLocal = declaredBasePath
        ? declaredBasePath.startsWith(`/${project_id}/`) ||
          declaredBasePath === `/${project_id}`
          ? declaredBasePath
          : `/${project_id}${declaredBasePath.startsWith("/") ? declaredBasePath : `/${declaredBasePath}`}`
        : undefined;
      const serviceOpenMode: AppServiceOpenMode =
        spec?.kind === "service" && spec?.proxy?.open_mode === "port"
          ? "port"
          : "proxy";
      const serviceLocal = translateServiceOpenUrl(status.url, serviceOpenMode);
      const preferredLocal =
        spec?.kind === "static"
          ? basePathLocal || serviceLocal
          : serviceLocal || basePathLocal;
      if (!preferredLocal) return;
      const local =
        withProjectHostBase(project_id, preferredLocal) ?? preferredLocal;
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
          open_mode: serviceOpenMode,
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
      setStartupFailures((prev) => ({ ...prev, [appId]: undefined }));
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
        await refresh();
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
      setStartupFailures((prev) => ({ ...prev, [id]: undefined }));
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
      setStartupFailures((prev) => ({ ...prev, [id]: undefined }));
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
      setStartupFailures((prev) => ({ ...prev, [id]: undefined }));
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
      setRowAction({ appId: id, action: "expose" });
      setError(undefined);
      setStartupFailures((prev) => ({ ...prev, [id]: undefined }));
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
      setRowAction(null);
    }
  }

  async function onUnexpose(id: string) {
    try {
      setSubmitting(true);
      setRowAction({ appId: id, action: "unexpose" });
      setError(undefined);
      await api.apps.unexposeApp(id);
      await refresh();
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setSubmitting(false);
      setRowAction(null);
    }
  }

  async function onAuditWithAgent(id: string) {
    try {
      setSubmitting(true);
      setRowAction({ appId: id, action: "audit" });
      setError(undefined);
      const next = await api.apps.auditAppPublicReadiness(id);
      setAudit(next);
      await sendAuditToAgent(next.agent_prompt);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setSubmitting(false);
      setRowAction(null);
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
        http_only: true,
        limit: 100,
      });
      setDetected(next);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setDetecting(false);
    }
  }

  async function onDetectInstalledTemplates() {
    try {
      setDetectingInstalledTemplates(true);
      setError(undefined);
      const next = await api.apps.detectInstalledTemplates();
      setInstalledTemplates(next);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setDetectingInstalledTemplates(false);
    }
  }

  async function onStartMany(ids: string[]) {
    if (ids.length === 0) return;
    try {
      setSubmitting(true);
      setError(undefined);
      for (const id of ids) {
        setStartupFailures((prev) => ({ ...prev, [id]: undefined }));
        try {
          await api.apps.ensureRunning(id, { timeout: 90_000, interval: 1000 });
        } catch (err) {
          await reportStartupFailure({ appId: id, action: "start", err });
        }
      }
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function onStopMany(ids: string[]) {
    if (ids.length === 0) return;
    try {
      setSubmitting(true);
      setError(undefined);
      for (const id of ids) {
        setStartupFailures((prev) => ({ ...prev, [id]: undefined }));
        await api.apps.stopApp(id);
      }
      await refresh();
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onExport(id: string) {
    try {
      setTransferBusy(true);
      setError(undefined);
      let spec = specById[id];
      if (!spec) {
        spec = await api.apps.getAppSpec(id);
        setSpecById((prev) => ({ ...prev, [id]: spec }));
      }
      downloadJsonFile(`${id}.app.json`, spec);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setTransferBusy(false);
    }
  }

  async function onExportAll() {
    try {
      setTransferBusy(true);
      setError(undefined);
      const records = await api.apps.listAppSpecs();
      const apps: AppSpec[] = [];
      const skipped: Array<{ id: string; path?: string; error: string }> = [];
      for (const row of records) {
        if (row.spec) {
          apps.push(row.spec);
        } else {
          skipped.push({
            id: row.id,
            path: row.path,
            error: row.error ?? "spec unavailable",
          });
        }
      }
      downloadJsonFile(
        `${project_id}-managed-apps.json`,
        createPortableBundle(project_id, apps, skipped),
      );
      if (skipped.length > 0) {
        Modal.warning({
          title: "Exported with skipped invalid app specs",
          content: `Exported ${apps.length} app(s). Skipped ${skipped.length} invalid spec file(s).`,
        });
      }
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setTransferBusy(false);
    }
  }

  async function onImportFile(file: File) {
    try {
      setTransferBusy(true);
      setError(undefined);
      const raw = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new Error(`Failed to parse ${file.name} as JSON: ${err}`);
      }
      const { format, apps, sourceWorkspaceId } = parseImportPayload(parsed);
      for (const spec of apps) {
        await api.apps.upsertAppSpec(spec);
      }
      await refresh();
      Modal.success({
        title: `Imported ${apps.length} app${apps.length === 1 ? "" : "s"}`,
        content:
          format === "bundle" && sourceWorkspaceId
            ? `Imported from workspace ${sourceWorkspaceId}.`
            : undefined,
      });
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setTransferBusy(false);
      if (importInputRef.current) {
        importInputRef.current.value = "";
      }
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
      out.push(`open=${spec?.proxy?.open_mode === "port" ? "port" : "proxy"}`);
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
      setStartupFailures((prev) => ({
        ...prev,
        [appId]: {
          appId,
          action,
          errorMessage: base.message,
          stdoutTail: tailLines(data.stdout),
          stderrTail: tailLines(data.stderr),
        },
      }));
    } catch {
      setStartupFailures((prev) => ({
        ...prev,
        [appId]: {
          appId,
          action,
          errorMessage: base.message,
        },
      }));
    }
  }

  return (
    <div>
      <Paragraph style={{ color: "#666", marginBottom: "8px" }}>
        Create and manage applications for this workspace, including private
        service apps and static apps.
      </Paragraph>
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          void onImportFile(file);
        }}
      />
      <ShowError error={error} setError={() => setError(undefined)} />
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
              <Select<AppServiceOpenMode>
                value={serviceOpenMode}
                style={{ width: "170px" }}
                options={[
                  { label: "Open: /proxy", value: "proxy" },
                  { label: "Open: /port", value: "port" },
                ]}
                onChange={(value) => setServiceOpenMode(value)}
              />
            </Space.Compact>
            <Paragraph style={{ color: "#666", margin: 0, fontSize: "12px" }}>
              Open mode: <code>/proxy</code> strips your app base path before
              forwarding; <code>/port</code> keeps the raw port-style URL path.
              Use <code>/port</code> for apps that do not proxy cleanly behind
              stripped base paths.
            </Paragraph>
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
          <Button onClick={() => void onExportAll()} loading={transferBusy}>
            Export all
          </Button>
          <Button
            onClick={() => importInputRef.current?.click()}
            disabled={transferBusy}
          >
            Import JSON
          </Button>
          <Button onClick={() => void onDetect()} loading={detecting}>
            Detect running HTTP apps
          </Button>
          <Button
            onClick={() => void onDetectInstalledTemplates()}
            loading={detectingInstalledTemplates}
          >
            Detect installed templates
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
      {installedTemplates.length > 0 ? (
        <>
          <div style={{ fontWeight: 600, marginBottom: "8px" }}>
            Installed templates
          </div>
          <Space wrap style={{ width: "100%", marginBottom: "12px" }}>
            {installedTemplates.map((item) => (
              <Tag
                key={item.key}
                color={item.available ? "green" : "default"}
                style={{ paddingInline: "10px", marginInlineEnd: 0 }}
              >
                {item.label}
                {item.details ? (
                  <span style={{ opacity: 0.8 }}> · {item.details}</span>
                ) : null}
              </Tag>
            ))}
          </Space>
          <Divider style={{ margin: "14px 0" }} />
        </>
      ) : null}
      {detected.length > 0 ? (
        <>
          <div style={{ fontWeight: 600, marginBottom: "8px" }}>
            Detected running HTTP apps
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
      <div style={{ fontWeight: 600, marginBottom: "8px" }}>Managed Applications</div>
      {loading ? <Spin /> : null}
      {!loading && rows.length === 0 ? (
        <Alert type="info" showIcon message="No managed app servers yet." />
      ) : null}
      {!loading && rows.length > 0 ? (
        <Space
          wrap
          style={{ width: "100%", justifyContent: "space-between", marginBottom: "10px" }}
        >
          <Space wrap>
            <Input
              value={rowSearch}
              placeholder="Filter apps"
              onChange={(e) => setRowSearch(e.target.value)}
              style={{ width: "220px" }}
              allowClear
            />
            <Select<AppStatusFilter>
              value={rowFilter}
              style={{ width: "150px" }}
              onChange={(value) => setRowFilter(value)}
              options={[
                { value: "all", label: "All" },
                { value: "running", label: "Running" },
                { value: "stopped", label: "Stopped" },
                { value: "error", label: "Needs attention" },
                { value: "public", label: "Public" },
              ]}
            />
          </Space>
          <Space wrap>
            <Button
              onClick={() => void onStartMany(startableRows.map((row) => row.id))}
              disabled={submitting || startableRows.length === 0}
            >
              Start all stopped ({startableRows.length})
            </Button>
            <Button
              onClick={() => void onStopMany(stoppableRows.map((row) => row.id))}
              disabled={submitting || stoppableRows.length === 0}
            >
              Stop all running ({stoppableRows.length})
            </Button>
          </Space>
        </Space>
      ) : null}
      <Space direction="vertical" style={{ width: "100%" }}>
        {filteredRows.map((row) => {
          const isRunning = row.state === "running";
          const isPublic = isPublicExposure(row);
          const spec = specById[row.id];
          const specSummary = summarizeSpec(spec);
          const startupFailure = startupFailures[row.id];
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
                    {isPublic ? <Tag color="gold">public</Tag> : null}
                  </div>
                  <div style={{ opacity: 0.7, fontFamily: "monospace", fontSize: "12px" }}>
                    {row.id}
                  </div>
                </div>
                <Space wrap>
                  <Button
                    size="small"
                    onClick={() => void openStatus(row)}
                    disabled={
                      !row.url && !buildPublicUrlFromExposure(row, publicAppPolicy)
                    }
                  >
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
                  {isPublic ? (
                    <Button
                      size="small"
                      onClick={() => void onUnexpose(row.id)}
                      loading={
                        submitting &&
                        rowAction?.appId === row.id &&
                        rowAction.action === "unexpose"
                      }
                    >
                      Unexpose
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      onClick={() => void onExpose(row.id)}
                      loading={
                        submitting &&
                        rowAction?.appId === row.id &&
                        rowAction.action === "expose"
                      }
                    >
                      Expose
                    </Button>
                  )}
                  <Button
                    size="small"
                    onClick={() => void onAuditWithAgent(row.id)}
                    loading={
                      submitting &&
                      rowAction?.appId === row.id &&
                      rowAction.action === "audit"
                    }
                  >
                    Audit with Codex
                  </Button>
                  <Button
                    size="small"
                    onClick={() => void onLogs(row.id)}
                  >
                    Logs
                  </Button>
                  <Button
                    size="small"
                    onClick={() => void onExport(row.id)}
                    loading={transferBusy}
                  >
                    Export
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
              {isPublic ? (
                <div style={{ marginTop: "8px", fontSize: "12px", opacity: 0.85 }}>
                  {buildPublicUrlFromExposure(row, publicAppPolicy) ? (
                    <>
                      Public URL:{" "}
                      <a
                        href={buildPublicUrlFromExposure(row, publicAppPolicy)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {buildPublicUrlFromExposure(row, publicAppPolicy)}
                      </a>
                    </>
                  ) : buildPublicHostnameFromExposure(row, publicAppPolicy) ? (
                    <>
                      Public Hostname:{" "}
                      {buildPublicHostnameFromExposure(row, publicAppPolicy)}
                    </>
                  ) : row.exposure?.random_subdomain ? (
                    <>Public exposure active (subdomain label: {row.exposure.random_subdomain})</>
                  ) : (
                    <>Public exposure active</>
                  )}
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
              {startupFailure ? (
                <Alert
                  style={{ marginTop: "8px" }}
                  type="error"
                  showIcon
                  closable
                  onClose={() =>
                    setStartupFailures((prev) => ({
                      ...prev,
                      [row.id]: undefined,
                    }))
                  }
                  message={`Failed to ${startupFailure.action === "start" ? "start" : "start after save"} '${row.title || row.id}'`}
                  description={
                    <div style={{ display: "grid", gap: "8px" }}>
                      <div>{startupFailure.errorMessage}</div>
                      <Space wrap>
                        <Button size="small" onClick={() => void onLogs(row.id)}>
                          View full logs
                        </Button>
                      </Space>
                      {startupFailure.stderrTail ? (
                        renderLogTailBlock({
                          label: "stderr (tail)",
                          content: startupFailure.stderrTail,
                          background: "#fff7f7",
                        })
                      ) : null}
                      {startupFailure.stdoutTail ? (
                        renderLogTailBlock({
                          label: "stdout (tail)",
                          content: startupFailure.stdoutTail,
                          background: "#fafafa",
                        })
                      ) : null}
                    </div>
                  }
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
              Send to Codex
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
              gridTemplateColumns: "1fr",
              gap: "10px",
            }}
          >
            <div>
              <div style={{ fontWeight: 600, marginBottom: "6px" }}>
                stdout
              </div>
              <div
                style={{
                  maxHeight: "32vh",
                  overflow: "auto",
                  border: "1px solid #eee",
                  borderRadius: "6px",
                  padding: "8px",
                  background: "#fafafa",
                }}
              >
                <StaticMarkdown value={toFencedCodeBlock(logsData.stdout || "(empty)", "sh")} />
              </div>
            </div>
            <div>
              <div style={{ fontWeight: 600, marginBottom: "6px" }}>
                stderr
              </div>
              <div
                style={{
                  maxHeight: "32vh",
                  overflow: "auto",
                  border: "1px solid #eee",
                  borderRadius: "6px",
                  padding: "8px",
                  background: "#fafafa",
                }}
              >
                <StaticMarkdown value={toFencedCodeBlock(logsData.stderr || "(empty)", "sh")} />
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
