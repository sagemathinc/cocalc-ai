/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Collapse,
  Dropdown,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import type {
  AppSpec,
  AppMetricsSummary,
  AppPublicReadinessAudit,
  AppTemplateCatalogEntry,
  DetectedAppPort,
  InstalledAppTemplate,
  ManagedAppStatus,
} from "@cocalc/conat/project/api/apps";
import { Paragraph } from "@cocalc/frontend/components";
import ShowError from "@cocalc/frontend/components/error";
import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import {
  dispatchNavigatorPromptIntent,
  submitNavigatorPromptToCurrentThread,
} from "@cocalc/frontend/project/new/navigator-intents";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { COLORS } from "@cocalc/util/theme";
import {
  appServerPresetsFromCatalogEntries,
  builtinAppServerPresets,
  type AppServerPreset,
  type AppServiceOpenMode,
} from "./app-template-catalog";
import { withProjectHostBase } from "./host-url";

type AppKind = "service" | "static";
type AppStatusFilter = "all" | "running" | "stopped" | "error" | "public";
type AppRowAction = "expose" | "unexpose" | "audit";

interface PublicAppPolicy {
  enabled: boolean;
  dns_domain?: string;
  subdomain_suffix?: string;
}

interface StartupFailureDetails {
  appId: string;
  action: "start" | "start-after-save";
  errorMessage: string;
  preset?: AppServerPreset;
  templateDetails?: string;
  stdoutTail?: string;
  stderrTail?: string;
  installCommand?: string;
  installHint?: string;
  installAgentPrompt?: string;
}

interface InstallWithCodexTarget {
  preset: AppServerPreset;
  templateDetails?: string;
  appId?: string;
  action?: "create" | "start" | "start-after-save";
}

interface PortableAppSpecBundle {
  version: 1;
  kind: "cocalc-app-spec-bundle";
  exported_at: string;
  workspace_id: string;
  apps: AppSpec[];
  skipped?: Array<{ id: string; path?: string; error: string }>;
}

const APP_SECURITY_MARKDOWN = `
### Security model

- Private managed apps use a **same-project trust model**.
- Opening a private app is similar to running project code from a notebook, terminal, or other project file.
- A private app is **not** an internal sandbox against other code in the same project.

### What CoCalc is designed to protect

- Public apps are exposed on separate public hostnames.
- Project-host session cookies are scoped to the current project instead of the whole host.
- Project-host auth/session cookies and bootstrap bearer headers are stripped before traffic is proxied upstream to the app.
- Private apps in one project cannot fetch private apps in another project on the same host.

### What this means in practice

- Do **not** open untrusted private apps in projects that contain sensitive files or secrets.
- Use **Expose** if an app should be reachable by other people on its own public hostname.
- Use **Audit with Codex** before exposing an app publicly if you want an extra review pass.

More detail: \`docs/security/private-app-trust-model.md\`
`;

const COCALC_CLI_DOWNLOAD_URL =
  "https://software.cocalc.ai/software/cocalc/index.html";

function getPresetTheme(preset: AppServerPreset): {
  accent: string;
  surface: string;
  icon: IconName;
} {
  const defaults: Record<
    string,
    { accent: string; surface: string; icon: IconName }
  > = {
    core: {
      accent: COLORS.BLUE_D,
      surface: COLORS.BLUE_LLLL,
      icon: "server",
    },
    docs: {
      accent: COLORS.BLUE_DOC,
      surface: COLORS.BLUE_LLLL,
      icon: "book",
    },
    publishing: {
      accent: COLORS.BRWN,
      surface: COLORS.YELL_LLL,
      icon: "layout",
    },
    "python-web": {
      accent: COLORS.BS_GREEN_D,
      surface: COLORS.BS_GREEN_LL,
      icon: "rocket",
    },
    "python-notebooks": {
      accent: COLORS.COCALC_ORANGE,
      surface: COLORS.YELL_LLL,
      icon: "edit",
    },
  };
  const fallback = defaults[preset.category ?? ""] ??
    defaults.core ?? {
      accent: COLORS.BLUE_D,
      surface: COLORS.GRAY_LLL,
      icon: "server" as IconName,
    };
  return {
    accent: preset.accentColor ?? fallback.accent,
    surface: preset.surfaceColor ?? fallback.surface,
    icon: (preset.icon as IconName | undefined) ?? fallback.icon,
  };
}

function PresetSummaryCard({
  preset,
  onClick,
  compact = false,
}: {
  preset: AppServerPreset;
  onClick?: () => void;
  compact?: boolean;
}) {
  const theme = getPresetTheme(preset);
  const heroHeight = compact ? 88 : 110;
  return (
    <Card
      size="small"
      hoverable={!!onClick}
      onClick={onClick}
      style={{
        cursor: onClick ? "pointer" : undefined,
        borderColor: theme.accent,
        background: `linear-gradient(135deg, ${theme.surface} 0%, white 78%)`,
        minHeight: compact ? 196 : undefined,
        overflow: "hidden",
      }}
    >
      <Space
        direction="vertical"
        size={compact ? 8 : 6}
        style={{ width: "100%" }}
      >
        <div
          style={{
            margin: "-12px -12px 0",
            height: heroHeight,
            borderBottom: `1px solid ${theme.accent}22`,
            backgroundColor: theme.surface,
            backgroundImage: preset.heroImage
              ? `url("${preset.heroImage}")`
              : `radial-gradient(circle at 82% 22%, ${theme.accent}22 0, ${theme.accent}22 18%, transparent 18%), linear-gradient(135deg, ${theme.surface} 0%, white 85%)`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
            position: "relative",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 16,
              bottom: -12,
              width: compact ? 40 : 46,
              height: compact ? 40 : 46,
              borderRadius: compact ? 14 : 16,
              background: theme.accent,
              color: "white",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: `0 10px 24px ${theme.accent}44`,
              border: "2px solid white",
            }}
          >
            <Icon name={theme.icon} />
          </div>
        </div>
        <Space
          align="start"
          style={{ width: "100%", justifyContent: "space-between" }}
        >
          <div style={{ minWidth: 0, paddingTop: compact ? 12 : 16 }}>
            <Typography.Text strong style={{ display: "block" }}>
              {preset.label}
            </Typography.Text>
            {preset.description ? (
              <Typography.Text
                type="secondary"
                style={{
                  display: "block",
                  marginTop: 2,
                  lineHeight: 1.35,
                }}
              >
                {preset.description}
              </Typography.Text>
            ) : null}
          </div>
          {preset.category ? (
            <Tag
              style={{
                marginInlineEnd: 0,
                borderColor: theme.accent,
                color: theme.accent,
                background: "white",
              }}
            >
              {preset.category}
            </Tag>
          ) : null}
        </Space>
        {!compact && preset.homepage ? (
          <a href={preset.homepage} target="_blank" rel="noreferrer">
            Learn more
          </a>
        ) : null}
      </Space>
    </Card>
  );
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

function shellQuoteCliArg(value: string): string {
  if (!value) return '""';
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : JSON.stringify(value);
}

function buildTunnelLocallyCommand(projectId: string, appId: string): string {
  return `cocalc project app forward --project=${shellQuoteCliArg(projectId)} ${shellQuoteCliArg(appId)}`;
}

function canInstallWithCodex(preset: AppServerPreset | undefined): boolean {
  if (!preset) return false;
  if (preset.installStrategy === "none") return false;
  return Boolean(
    preset.installAgentPrompt ||
    preset.installCommand ||
    preset.installRecipes?.length ||
    preset.agentPromptSeed,
  );
}

function formatSnapshotNameTimestamp(date = new Date()): string {
  const pad = (n: number) => `${n}`.padStart(2, "0");
  return [
    `${date.getFullYear()}`,
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function makeInstallSnapshotName(templateId: string): string {
  const safeId = `${templateId ?? "app"}`
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `pre-install-${safeId || "app"}-${formatSnapshotNameTimestamp()}`;
}

function buildInstallWithCodexThreadTitle(preset: AppServerPreset): string {
  return `Install ${preset.title}`;
}

function buildInstallWithCodexPrompt(opts: {
  projectId: string;
  preset: AppServerPreset;
  templateDetails?: string;
  appId?: string;
  action?: "create" | "start" | "start-after-save";
  snapshotName?: string;
}): string {
  const lines: string[] = [];
  const { preset } = opts;
  const actionText =
    opts.action === "start-after-save"
      ? "after saving the managed app"
      : opts.action === "start"
        ? "before starting the managed app"
        : "for a managed app template";
  lines.push(
    `Install the '${preset.label}' app runtime in CoCalc project ${opts.projectId} ${actionText}.`,
    "",
    "Environment assumptions:",
    "- This is a CoCalc Launchpad-style project environment.",
    "- The project usually runs inside a podman container.",
    "- The user is typically root inside the container.",
    "- Prefer systemwide installation when practical.",
    "- When a curated distro recipe is provided, prefer that exact recipe over exploratory package searching.",
    "- snap is not supported here and should not be used.",
  );
  if (opts.snapshotName) {
    lines.push(
      "",
      `A project filesystem snapshot was already created before this install: ${opts.snapshotName}`,
      "Mention that snapshot name in your final summary so the user can roll back if needed.",
    );
  } else {
    lines.push(
      "",
      "No project snapshot name was provided with this install request.",
      "Do not spend time debugging CoCalc CLI authentication from inside the container just to create a snapshot.",
      "If a snapshot is already known, mention it. Otherwise proceed carefully and clearly state that no snapshot was created automatically.",
    );
  }
  lines.push(
    "",
    `Template id: ${preset.id}`,
    `Category: ${preset.category ?? "uncategorized"}`,
  );
  if (preset.description) {
    lines.push(`Description: ${preset.description}`);
  }
  if (preset.homepage) {
    lines.push(`Docs/homepage: ${preset.homepage}`);
  }
  if (opts.appId) {
    lines.push(`Managed app id: ${opts.appId}`);
  }
  if (`${opts.templateDetails ?? ""}`.trim()) {
    lines.push(`Current detection status: ${`${opts.templateDetails}`.trim()}`);
  }
  if (preset.installHint) {
    lines.push("", `Install hint: ${preset.installHint}`);
  }
  if (preset.installCommand && !preset.installRecipes?.length) {
    lines.push(
      "",
      "Suggested starting command:",
      toFencedCodeBlock(preset.installCommand, "sh"),
    );
  }
  if (preset.installRecipes?.length) {
    lines.push(
      "",
      "Curated install recipes (try these before improvising a different install path):",
    );
    for (const recipe of preset.installRecipes) {
      const match: string[] = [];
      if (recipe.match?.os_family?.length) {
        match.push(`os_family=${recipe.match.os_family.join(",")}`);
      }
      if (recipe.match?.distro?.length) {
        match.push(`distro=${recipe.match.distro.join(",")}`);
      }
      lines.push(
        `- ${recipe.id}${match.length ? ` (${match.join("; ")})` : ""}`,
      );
      lines.push(toFencedCodeBlock(recipe.commands.join("\n"), "sh"));
      if (recipe.notes) {
        lines.push(`  Notes: ${recipe.notes}`);
      }
    }
  }
  if (preset.verifyCommands?.length) {
    lines.push(
      "",
      "Verification commands:",
      toFencedCodeBlock(preset.verifyCommands.join("\n"), "sh"),
    );
  }
  if (preset.command) {
    lines.push(
      "",
      "Managed app launch command after install:",
      toFencedCodeBlock(preset.command, "sh"),
    );
  }
  if (preset.agentPromptSeed) {
    lines.push("", `Extra guidance: ${preset.agentPromptSeed}`);
  }
  lines.push(
    "",
    "Requirements:",
    "1. Inspect the environment briefly and choose an appropriate install path.",
    "2. If a curated recipe matches the environment, use that recipe directly before package-searching or inventing an alternative path.",
    "3. Avoid unnecessary reinstalls if the runtime is already present.",
    "4. Install systemwide when practical for this project environment.",
    "5. Do not spend time debugging CoCalc CLI auth, browser automation, or unrelated control-plane issues unless the install strictly depends on them.",
    "6. Verify the relevant commands work after installation.",
    "7. If install succeeds, mention how to start or retry the managed app and use the provided managed app launch command for any short probe.",
    "8. In the final summary, report the snapshot name if one exists, exact commands used, and any rollback guidance.",
  );
  return lines.join("\n");
}

function formatBytes(value?: number): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = n;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = size >= 10 || unit === 0 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unit]}`;
}

function formatCount(value?: number): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0";
  return Math.round(n).toLocaleString();
}

function formatLatency(value?: number | null): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "n/a";
  return `${Math.round(n).toLocaleString()} ms`;
}

function MetricStat({
  label,
  value,
  subtle,
}: {
  label: string;
  value: ReactNode;
  subtle?: boolean;
}) {
  return (
    <div
      style={{
        border: "1px solid #f0f0f0",
        borderRadius: "8px",
        padding: "8px 10px",
        background: subtle ? "#fcfcfc" : "#fff",
        minHeight: "58px",
      }}
    >
      <div style={{ fontSize: "11px", opacity: 0.72, marginBottom: "3px" }}>
        {label}
      </div>
      <div style={{ fontSize: "14px", fontWeight: 600, lineHeight: 1.25 }}>
        {value}
      </div>
    </div>
  );
}

function MetricsSparkline({
  values,
  width = 120,
  height = 28,
  color = "#1677ff",
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (!values.length || values.every((value) => value === 0)) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <line
          x1={0}
          y1={height - 1}
          x2={width}
          y2={height - 1}
          stroke="#d9d9d9"
          strokeWidth="1"
        />
      </svg>
    );
  }
  const max = Math.max(...values, 1);
  const points = values
    .map((value, idx) => {
      const x =
        values.length === 1 ? width / 2 : (idx / (values.length - 1)) * width;
      const y = height - (value / max) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <line
        x1={0}
        y1={height - 1}
        x2={width}
        y2={height - 1}
        stroke="#d9d9d9"
        strokeWidth="1"
      />
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}

function normalizeCommand(exec?: string, args?: string[]): string {
  return exec ? [exec, ...(args ?? [])].join(" ").trim() : "";
}

function matchPresetForSpec(
  spec: AppSpec | undefined,
  presets: AppServerPreset[],
): AppServerPreset | undefined {
  if (!spec) return;
  const byId = presets.find((preset) => preset.id === spec.id);
  if (byId) return byId;
  if (spec.kind === "service") {
    const command = normalizeCommand(spec.command?.exec, spec.command?.args);
    return presets.find(
      (preset) =>
        preset.kind === "service" &&
        normalizeCommand("bash", ["-lc", preset.command ?? ""]) === command,
    );
  }
  if (spec.kind === "static") {
    return presets.find(
      (preset) =>
        preset.kind === "static" &&
        `${preset.staticIndex ?? ""}`.trim() ===
          `${spec.static?.index ?? ""}`.trim() &&
        `${preset.staticRefreshCommand ?? ""}`.trim() ===
          `${spec.static?.refresh?.command?.args?.[1] ?? ""}`.trim(),
    );
  }
  return;
}

function isPositiveIntegerText(value: string): boolean {
  const text = `${value ?? ""}`.trim();
  if (!text) return false;
  const n = Number(text);
  return Number.isInteger(n) && n > 0;
}

export function AppServerPanel({ project_id }: { project_id: string }) {
  const homeDirectory = useMemo(
    () => getProjectHomeDirectory(project_id),
    [project_id],
  );
  const fallbackPresets = useMemo(
    () => builtinAppServerPresets(homeDirectory),
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
  const [templateEntries, setTemplateEntries] = useState<
    AppTemplateCatalogEntry[]
  >([]);
  const [logsOpen, setLogsOpen] = useState<boolean>(false);
  const [logsLoading, setLogsLoading] = useState<boolean>(false);
  const [logsData, setLogsData] = useState<{
    id: string;
    state: "running" | "stopped";
    stdout: string;
    stderr: string;
  } | null>(null);
  const [securityOpen, setSecurityOpen] = useState<boolean>(false);
  const [localTunnelTarget, setLocalTunnelTarget] =
    useState<ManagedAppStatus | null>(null);
  const [installWithCodexTarget, setInstallWithCodexTarget] =
    useState<InstallWithCodexTarget | null>(null);
  const [installWithCodexSnapshot, setInstallWithCodexSnapshot] =
    useState<boolean>(true);
  const [installWithCodexSnapshotName, setInstallWithCodexSnapshotName] =
    useState<string>("");
  const [installWithCodexLaunching, setInstallWithCodexLaunching] =
    useState<boolean>(false);
  const [specById, setSpecById] = useState<Record<string, AppSpec | undefined>>(
    {},
  );
  const [metricsById, setMetricsById] = useState<
    Record<string, AppMetricsSummary | undefined>
  >({});
  const [metricsRefreshing, setMetricsRefreshing] = useState<
    Record<string, boolean | undefined>
  >({});
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
  const presetSelectorContainerRef = useRef<HTMLDivElement | null>(null);
  const [creatorOpen, setCreatorOpen] = useState<boolean>(false);
  const [creatorInitialized, setCreatorInitialized] = useState<boolean>(false);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const presets = useMemo(
    () =>
      templateEntries.length > 0
        ? appServerPresetsFromCatalogEntries(templateEntries, homeDirectory)
        : fallbackPresets,
    [fallbackPresets, homeDirectory, templateEntries],
  );

  const activePreset = useMemo(
    () => presets.find((preset) => preset.key === presetKey),
    [presets, presetKey],
  );
  const installedTemplateMap = useMemo(
    () =>
      Object.fromEntries(
        installedTemplates.map((item) => [item.key, item] as const),
      ) as Record<string, InstalledAppTemplate | undefined>,
    [installedTemplates],
  );
  const activePresetTemplate = activePreset
    ? installedTemplateMap[activePreset.key]
    : undefined;
  const unavailableActivePreset =
    activePreset &&
    activePresetTemplate &&
    activePresetTemplate.status !== "unknown" &&
    !activePresetTemplate.available
      ? activePreset
      : undefined;
  const installWithCodexPromptPreview = useMemo(() => {
    if (!installWithCodexTarget) return "";
    return buildInstallWithCodexPrompt({
      projectId: project_id,
      preset: installWithCodexTarget.preset,
      templateDetails: installWithCodexTarget.templateDetails,
      appId: installWithCodexTarget.appId,
      action: installWithCodexTarget.action,
      snapshotName: installWithCodexSnapshot
        ? `${installWithCodexSnapshotName ?? ""}`.trim() ||
          makeInstallSnapshotName(installWithCodexTarget.preset.id)
        : undefined,
    });
  }, [
    installWithCodexSnapshot,
    installWithCodexSnapshotName,
    installWithCodexTarget,
    project_id,
  ]);

  useEffect(() => {
    if (!installWithCodexTarget) return;
    setInstallWithCodexSnapshot(true);
    setInstallWithCodexSnapshotName(
      makeInstallSnapshotName(installWithCodexTarget.preset.id),
    );
  }, [installWithCodexTarget]);

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
        !!row.error ||
        !!startupFailures[row.id] ||
        (row.warnings?.length ?? 0) > 0;
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

  const summaryCounts = useMemo(() => {
    const running = rows.filter((row) => row.state === "running").length;
    const exposed = rows.filter((row) => isPublicExposure(row)).length;
    const attention = rows.filter(
      (row) =>
        !!row.error ||
        !!startupFailures[row.id] ||
        (row.warnings?.length ?? 0) > 0,
    ).length;
    return {
      total: rows.length,
      running,
      stopped: Math.max(0, rows.length - running),
      exposed,
      attention,
    };
  }, [rows, startupFailures]);
  const siteOrigin = useMemo(() => {
    if (typeof window === "undefined" || !window.location?.origin) return "";
    return window.location.origin.replace(/\/+$/, "");
  }, []);

  const quickPresetKeys = useMemo(
    () => [
      "jupyterlab",
      "code-server",
      "pluto",
      "rstudio",
      "python-hello",
      "static-hello",
    ],
    [],
  );
  const quickPresets = useMemo(
    () => presets.filter((preset) => quickPresetKeys.includes(preset.key)),
    [presets, quickPresetKeys],
  );

  useEffect(() => {
    let cancelled = false;
    async function loadPublicAppPolicy() {
      try {
        const policy =
          await webapp_client.conat_client.hub.system.getProjectAppPublicPolicy(
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
    () =>
      rows.filter((row) => row.kind === "service" && row.state !== "running"),
    [rows],
  );
  const stoppableRows = useMemo(
    () =>
      rows.filter((row) => row.kind === "service" && row.state === "running"),
    [rows],
  );

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      setStartupFailures({});
      const [next, specRecords, metrics, templates] = await Promise.all([
        api.apps.listAppStatuses(),
        api.apps.listAppSpecs(),
        api.apps.listAppMetrics({ minutes: 60 }),
        api.apps.listAppTemplates(),
      ]);
      setRows(next.sort((a, b) => a.id.localeCompare(b.id)));
      const map: Record<string, AppSpec | undefined> = {};
      for (const row of specRecords) {
        if (row.spec?.id) {
          map[row.spec.id] = row.spec;
        }
      }
      setSpecById(map);
      setMetricsById(
        Object.fromEntries(metrics.map((item) => [item.app_id, item] as const)),
      );
      setTemplateEntries(templates);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshMetricsForApp = useCallback(
    async (appId: string) => {
      try {
        setMetricsRefreshing((prev) => ({ ...prev, [appId]: true }));
        const next = await api.apps.appMetrics(appId, { minutes: 60 });
        setMetricsById((prev) => ({ ...prev, [appId]: next }));
      } catch (err) {
        setError(normalizeError(err));
      } finally {
        setMetricsRefreshing((prev) => ({ ...prev, [appId]: undefined }));
      }
    },
    [api],
  );

  useEffect(() => {
    if (creatorInitialized || loading) return;
    setCreatorOpen(false);
    setCreatorInitialized(true);
  }, [creatorInitialized, loading]);

  useEffect(() => {
    if (detectingInstalledTemplates || installedTemplates.length > 0) return;
    void onDetectInstalledTemplates();
  }, [detectingInstalledTemplates, installedTemplates.length]);

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
      setStaticCacheControl(preset.staticCacheControl ?? "public,max-age=3600");
      setStaticRefreshCommand(preset.staticRefreshCommand ?? "");
      setStaticRefreshStaleAfter(preset.staticRefreshStaleAfter ?? "3600");
      setStaticRefreshTimeout(preset.staticRefreshTimeout ?? "120");
      setStaticRefreshOnHit(preset.staticRefreshOnHit ?? true);
      setServiceOpenMode("proxy");
      setStartNow(false);
      setOpenWhenReady(false);
    }
  }

  function resetCreatorForm() {
    setPresetKey("");
    setKind("service");
    setAppId("");
    setTitle("");
    setBasePath("");
    setCommand("");
    setPort("");
    setHealthPath("");
    setServiceOpenMode("proxy");
    setStaticRoot("");
    setStaticIndex("index.html");
    setStaticCacheControl("public,max-age=3600");
    setStaticRefreshCommand("");
    setStaticRefreshStaleAfter("3600");
    setStaticRefreshTimeout("120");
    setStaticRefreshOnHit(true);
    setStartNow(true);
    setOpenWhenReady(true);
  }

  function focusPresetSelector() {
    setTimeout(() => {
      presetSelectorContainerRef.current
        ?.querySelector<HTMLInputElement>("input")
        ?.focus();
    }, 0);
  }

  function openCreator() {
    setCreatorOpen(true);
    focusPresetSelector();
  }

  function toggleRowExpanded(id: string) {
    setExpandedRows((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  }

  async function sendAgentPrompt(
    prompt: string,
    tag: string,
    opts?: {
      title?: string;
      codexConfig?: {
        sessionMode?: "read-only" | "workspace-write" | "full-access";
        allowWrite?: boolean;
        workingDirectory?: string;
      };
    },
  ) {
    const text = `${prompt ?? ""}`.trim();
    const title = `${opts?.title ?? ""}`.trim() || undefined;
    if (!text) return;
    try {
      setSubmittingToAgent(true);
      const sent = await submitNavigatorPromptToCurrentThread({
        project_id,
        prompt: text,
        title,
        tag,
        forceCodex: true,
        openFloating: true,
        codexConfig: opts?.codexConfig,
      });
      if (!sent) {
        dispatchNavigatorPromptIntent({
          prompt: text,
          title,
          tag,
          forceCodex: true,
          codexConfig: opts?.codexConfig,
        });
      }
    } finally {
      setSubmittingToAgent(false);
    }
  }

  function openInstallWithCodex(target: InstallWithCodexTarget) {
    setInstallWithCodexTarget(target);
  }

  async function launchInstallWithCodex() {
    if (!installWithCodexTarget) return;
    const snapshotName = `${installWithCodexSnapshotName ?? ""}`.trim();
    try {
      setInstallWithCodexLaunching(true);
      setError(undefined);
      let createdSnapshotName: string | undefined;
      if (installWithCodexSnapshot) {
        createdSnapshotName =
          snapshotName ||
          makeInstallSnapshotName(installWithCodexTarget.preset.id);
        await webapp_client.conat_client.hub.projects.createSnapshot({
          project_id,
          name: createdSnapshotName,
        });
      }
      const prompt = buildInstallWithCodexPrompt({
        projectId: project_id,
        preset: installWithCodexTarget.preset,
        templateDetails: installWithCodexTarget.templateDetails,
        appId: installWithCodexTarget.appId,
        action: installWithCodexTarget.action,
        snapshotName: createdSnapshotName,
      });
      await sendAgentPrompt(prompt, "intent:app-server-install", {
        title: buildInstallWithCodexThreadTitle(installWithCodexTarget.preset),
        codexConfig: {
          sessionMode: "full-access",
          allowWrite: true,
          workingDirectory: homeDirectory,
        },
      });
      setInstallWithCodexTarget(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setInstallWithCodexLaunching(false);
    }
  }

  async function resolveInstalledTemplateMap(): Promise<
    Record<string, InstalledAppTemplate | undefined>
  > {
    if (installedTemplates.length > 0) return installedTemplateMap;
    const next = await api.apps.detectInstalledTemplates();
    setInstalledTemplates(next);
    return Object.fromEntries(
      next.map((item) => [item.key, item] as const),
    ) as Record<string, InstalledAppTemplate | undefined>;
  }

  async function getMissingInstallForSpec(spec: AppSpec | undefined): Promise<
    | {
        preset: AppServerPreset;
        template?: InstalledAppTemplate;
      }
    | undefined
  > {
    const preset = matchPresetForSpec(spec, presets);
    if (!preset || preset.kind !== "service") return;
    const map = await resolveInstalledTemplateMap();
    const template = map[preset.key];
    if (template && template.status === "unknown") {
      return;
    }
    if (!template?.available) {
      return { preset, template };
    }
    return;
  }

  function reportMissingInstall({
    appId,
    action,
    preset,
    template,
  }: {
    appId: string;
    action: "start" | "start-after-save";
    preset: AppServerPreset;
    template?: InstalledAppTemplate;
  }) {
    const details = `${template?.details ?? ""}`.trim();
    const message = `${preset.label} is not installed in this project yet. Install it, then start this app again.`;
    setStartupFailures((prev) => ({
      ...prev,
      [appId]: {
        appId,
        action,
        errorMessage: details ? `${message} (${details})` : message,
        preset,
        templateDetails: details || undefined,
        installCommand: preset.installCommand,
        installHint: preset.installHint,
        installAgentPrompt: preset.installAgentPrompt,
      },
    }));
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
      if (
        parsedPort != null &&
        (!Number.isInteger(parsedPort) || parsedPort <= 0)
      ) {
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
        throw new Error(
          "Static refresh stale-after must be a positive integer.",
        );
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
    const shouldOpenWhenReady = openWhenReady;
    try {
      setFormSubmitting(true);
      setError(undefined);
      setStartupFailures((prev) => ({ ...prev, [appId]: undefined }));
      const spec = buildSpec();
      const { id } = await api.apps.upsertAppSpec(spec);
      createdId = id;
      let status = await api.apps.statusApp(id);
      if (startNow && spec.kind === "service") {
        const missingInstall = await getMissingInstallForSpec(spec);
        if (missingInstall) {
          await refresh();
          reportMissingInstall({
            appId: id,
            action: "start-after-save",
            preset: missingInstall.preset,
            template: missingInstall.template,
          });
          return;
        }
        status = await api.apps.ensureRunning(id, {
          timeout: 90_000,
          interval: 1000,
        });
      }
      await refresh();
      resetCreatorForm();
      setCreatorOpen(false);
      if (shouldOpenWhenReady && status.state === "running") {
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
      const spec = specById[id] ?? (await api.apps.getAppSpec(id));
      setSpecById((prev) => ({ ...prev, [id]: spec }));
      const missingInstall = await getMissingInstallForSpec(spec);
      if (missingInstall) {
        reportMissingInstall({
          appId: id,
          action: "start",
          preset: missingInstall.preset,
          template: missingInstall.template,
        });
        return;
      }
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
      const auditTitle = specById[id]?.title
        ? `Audit ${specById[id]?.title}`
        : "Audit App Public Readiness";
      await sendAgentPrompt(next.agent_prompt, "intent:app-server-audit", {
        title: auditTitle,
      });
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setSubmitting(false);
      setRowAction(null);
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
          const spec = specById[id] ?? (await api.apps.getAppSpec(id));
          setSpecById((prev) => ({ ...prev, [id]: spec }));
          const missingInstall = await getMissingInstallForSpec(spec);
          if (missingInstall) {
            reportMissingInstall({
              appId: id,
              action: "start",
              preset: missingInstall.preset,
              template: missingInstall.template,
            });
            continue;
          }
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
            ? `Imported from project ${sourceWorkspaceId}.`
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

  function onTunnelLocally(row: ManagedAppStatus) {
    setLocalTunnelTarget(row);
  }

  function onRowMenuAction(
    row: ManagedAppStatus,
    action:
      | "tunnel"
      | "expose"
      | "unexpose"
      | "audit"
      | "logs"
      | "export"
      | "edit"
      | "delete",
  ) {
    switch (action) {
      case "tunnel":
        onTunnelLocally(row);
        return;
      case "expose":
        void onExpose(row.id);
        return;
      case "unexpose":
        void onUnexpose(row.id);
        return;
      case "audit":
        void onAuditWithAgent(row.id);
        return;
      case "logs":
        void onLogs(row.id);
        return;
      case "export":
        void onExport(row.id);
        return;
      case "edit":
        void onEditSpec(row.id);
        return;
      case "delete":
        Modal.confirm({
          title: "Delete app spec?",
          content: `Delete '${row.id}' and its managed status.`,
          okText: "Delete",
          okButtonProps: { danger: true },
          onOk: async () => onDelete(row.id),
        });
        return;
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
    <div style={{ display: "grid", gap: "12px" }}>
      <div>
        <div style={{ fontSize: "20px", fontWeight: 700, marginBottom: "4px" }}>
          Managed Applications
        </div>
        <Paragraph style={{ color: "#666", marginBottom: 0 }}>
          Run, expose, and troubleshoot project apps without mixing this page
          with normal file-creation workflows.
        </Paragraph>
      </div>
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
      <Card
        size="small"
        style={{ background: "#fafafa", borderColor: "#efefef" }}
      >
        <Space wrap style={{ width: "100%", justifyContent: "space-between" }}>
          <Space wrap>
            <Tag color="blue">apps {summaryCounts.total}</Tag>
            <Tag color={summaryCounts.running > 0 ? "green" : "default"}>
              running {summaryCounts.running}
            </Tag>
            <Tag color={summaryCounts.exposed > 0 ? "gold" : "default"}>
              public {summaryCounts.exposed}
            </Tag>
            <Tag color={summaryCounts.attention > 0 ? "red" : "default"}>
              attention {summaryCounts.attention}
            </Tag>
          </Space>
          <Space wrap>
            <Button
              onClick={() => {
                if (creatorOpen) {
                  setCreatorOpen(false);
                  return;
                }
                openCreator();
              }}
            >
              {creatorOpen ? "Hide new app form" : "New app"}
            </Button>
            <Button onClick={() => setSecurityOpen(true)}>Security?</Button>
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
        </Space>
      </Card>
      <Card
        size="small"
        title="Create a managed application"
        extra={
          <Button
            type="link"
            onClick={() => {
              if (creatorOpen) {
                setCreatorOpen(false);
                return;
              }
              openCreator();
            }}
          >
            {creatorOpen ? "Collapse" : "Expand"}
          </Button>
        }
      >
        {!creatorOpen ? (
          <Space direction="vertical" style={{ width: "100%" }} size={10}>
            <Paragraph style={{ color: COLORS.GRAY_M, marginBottom: 0 }}>
              Start from a preset or expand the full form when you need custom
              commands and proxy settings.
            </Paragraph>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: "12px",
                width: "100%",
              }}
            >
              {quickPresets.map((preset) => (
                <PresetSummaryCard
                  key={preset.key}
                  preset={preset}
                  compact
                  onClick={() => {
                    applyPreset(preset.key);
                    openCreator();
                  }}
                />
              ))}
            </div>
            <Button
              block
              size="large"
              onClick={() => openCreator()}
              style={{ marginTop: "4px" }}
            >
              More...
            </Button>
          </Space>
        ) : (
          <Space direction="vertical" style={{ width: "100%" }} size={10}>
            <div ref={presetSelectorContainerRef}>
              <Select
                value={presetKey || undefined}
                placeholder="Preset (optional)"
                allowClear
                showSearch
                optionFilterProp="label"
                filterOption={(input, option) => {
                  const haystack = [option?.label, (option as any)?.searchText]
                    .join(" ")
                    .toLowerCase();
                  return haystack.includes(input.trim().toLowerCase());
                }}
                style={{ width: "100%", minWidth: "320px" }}
                onClear={() => setPresetKey("")}
                onChange={(value) => applyPreset(value)}
                options={presets.map((preset) => ({
                  value: preset.key,
                  label: `${preset.label}${preset.description ? ` - ${preset.description}` : preset.category ? ` - ${preset.category}` : ""}`,
                  searchText: [
                    preset.label,
                    preset.title,
                    preset.category,
                    preset.description,
                    preset.homepage,
                  ]
                    .filter(Boolean)
                    .join(" "),
                }))}
              />
            </div>
            {activePreset ? <PresetSummaryCard preset={activePreset} /> : null}
            {activePreset?.note ? (
              <Alert type="info" showIcon title={activePreset.note} />
            ) : null}
            {unavailableActivePreset && activePresetTemplate ? (
              <Alert
                type="warning"
                showIcon
                title={`${unavailableActivePreset.label} is not installed yet`}
                description={
                  <Space
                    direction="vertical"
                    size={8}
                    style={{ width: "100%" }}
                  >
                    <div>
                      {unavailableActivePreset.installHint ??
                        "Install this runtime in the project before trying to start the app."}
                    </div>
                    {activePresetTemplate.details ? (
                      <div style={{ opacity: 0.8 }}>
                        Detected state: {activePresetTemplate.details}
                      </div>
                    ) : null}
                    {unavailableActivePreset.installCommand ? (
                      <div
                        style={{
                          fontFamily: "monospace",
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                          padding: "8px",
                          background: "#fafafa",
                          border: "1px solid #eee",
                          borderRadius: "6px",
                        }}
                      >
                        {unavailableActivePreset.installCommand}
                      </div>
                    ) : null}
                    {canInstallWithCodex(unavailableActivePreset) ? (
                      <div>
                        <Button
                          size="small"
                          onClick={() =>
                            openInstallWithCodex({
                              preset: unavailableActivePreset,
                              templateDetails: activePresetTemplate.details,
                              action: "create",
                            })
                          }
                          loading={
                            submittingToAgent || installWithCodexLaunching
                          }
                        >
                          Install with Codex
                        </Button>
                      </div>
                    ) : null}
                  </Space>
                }
              />
            ) : null}
            <Collapse
              defaultActiveKey={[
                "basics",
                kind === "service" ? "runtime" : "static",
              ]}
              items={[
                {
                  key: "basics",
                  label: "Basics",
                  children: (
                    <Space
                      direction="vertical"
                      style={{ width: "100%" }}
                      size={8}
                    >
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
                    </Space>
                  ),
                },
                kind === "service"
                  ? {
                      key: "runtime",
                      label: "Runtime and proxy",
                      children: (
                        <Space
                          direction="vertical"
                          style={{ width: "100%" }}
                          size={8}
                        >
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
                          <Paragraph
                            style={{
                              color: "#666",
                              margin: 0,
                              fontSize: "12px",
                            }}
                          >
                            Open mode: <code>/proxy</code> strips your app base
                            path before forwarding; <code>/port</code> keeps the
                            raw port-style URL path. Use <code>/port</code> for
                            apps that do not proxy cleanly behind stripped base
                            paths.
                          </Paragraph>
                        </Space>
                      ),
                    }
                  : {
                      key: "static",
                      label: "Static content and refresh",
                      children: (
                        <Space
                          direction="vertical"
                          style={{ width: "100%" }}
                          size={8}
                        >
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
                              onChange={(e) =>
                                setStaticCacheControl(e.target.value)
                              }
                            />
                          </Space.Compact>
                          <Input
                            value={staticRefreshCommand}
                            placeholder="Refresh command (optional, runs on first/stale hit)"
                            onChange={(e) =>
                              setStaticRefreshCommand(e.target.value)
                            }
                          />
                          <Space.Compact style={{ width: "100%" }}>
                            <Input
                              value={staticRefreshStaleAfter}
                              placeholder="Refresh stale-after seconds (default 3600)"
                              onChange={(e) =>
                                setStaticRefreshStaleAfter(e.target.value)
                              }
                            />
                            <Input
                              value={staticRefreshTimeout}
                              placeholder="Refresh timeout seconds (default 120)"
                              onChange={(e) =>
                                setStaticRefreshTimeout(e.target.value)
                              }
                            />
                          </Space.Compact>
                          <Checkbox
                            checked={staticRefreshOnHit}
                            onChange={(e) =>
                              setStaticRefreshOnHit(e.target.checked)
                            }
                          >
                            Trigger refresh on hit when stale
                          </Checkbox>
                        </Space>
                      ),
                    },
                {
                  key: "launch",
                  label: "Launch and public defaults",
                  children: (
                    <Space
                      direction="vertical"
                      style={{ width: "100%" }}
                      size={8}
                    >
                      <Space wrap>
                        <Checkbox
                          checked={startNow}
                          onChange={(e) => setStartNow(e.target.checked)}
                        >
                          Start after save
                        </Checkbox>
                        <Checkbox
                          checked={openWhenReady}
                          onChange={(e) => setOpenWhenReady(e.target.checked)}
                        >
                          Open when ready
                        </Checkbox>
                      </Space>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: "12px",
                          color: "#666",
                        }}
                      >
                        Public expose defaults
                      </div>
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
                          onChange={(e) =>
                            setExposeRandomSubdomain(e.target.checked)
                          }
                        >
                          Random subdomain
                        </Checkbox>
                        {!exposeRandomSubdomain ? (
                          <Input
                            value={exposeSubdomainLabel}
                            onChange={(e) =>
                              setExposeSubdomainLabel(e.target.value)
                            }
                            placeholder="subdomain label (optional)"
                            style={{ width: "220px" }}
                          />
                        ) : null}
                      </Space>
                    </Space>
                  ),
                },
              ]}
            />
            <Space wrap>
              <Button
                type="primary"
                loading={formSubmitting}
                disabled={!canSaveForm}
                onClick={() => void onCreate()}
              >
                Save app
              </Button>
            </Space>
          </Space>
        )}
      </Card>
      {installedTemplates.length > 0 ? (
        <Card
          size="small"
          title={`Installed templates (${installedTemplates.length})`}
        >
          <Space wrap style={{ width: "100%" }}>
            {installedTemplates.map((item) => (
              <Tag
                key={item.key}
                color={
                  item.available
                    ? "green"
                    : item.status === "unknown"
                      ? "gold"
                      : "default"
                }
                style={{ paddingInline: "10px", marginInlineEnd: 0 }}
              >
                {item.label}
                {item.details ? (
                  <span style={{ opacity: 0.8 }}> · {item.details}</span>
                ) : null}
              </Tag>
            ))}
          </Space>
        </Card>
      ) : null}
      {detected.length > 0 ? (
        <Card
          size="small"
          title={`Detected running HTTP apps (${detected.length})`}
        >
          <Space direction="vertical" style={{ width: "100%" }}>
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
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "8px",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>:{item.port}</div>
                    <div style={{ opacity: 0.8 }}>
                      hosts: {item.hosts.join(", ")}
                    </div>
                    <div style={{ opacity: 0.8 }}>
                      {item.managed
                        ? `managed by ${item.managed_app_ids.join(", ")}`
                        : "not managed"}
                    </div>
                  </div>
                  <Space wrap>
                    <Button
                      size="small"
                      onClick={() => {
                        useDetectedPort(item.port);
                        setCreatorOpen(true);
                      }}
                    >
                      Use in form
                    </Button>
                  </Space>
                </div>
              </div>
            ))}
          </Space>
        </Card>
      ) : null}
      <Card
        size="small"
        title={`Managed Applications (${summaryCounts.total})`}
      >
        {loading ? <Spin /> : null}
        {!loading && rows.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No managed applications yet."
          />
        ) : null}
        {!loading && rows.length > 0 ? (
          <Space
            wrap
            style={{
              width: "100%",
              justifyContent: "space-between",
              marginBottom: "10px",
            }}
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
                onClick={() =>
                  void onStartMany(startableRows.map((row) => row.id))
                }
                disabled={submitting || startableRows.length === 0}
              >
                Start all stopped ({startableRows.length})
              </Button>
              <Button
                onClick={() =>
                  void onStopMany(stoppableRows.map((row) => row.id))
                }
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
            const metrics = metricsById[row.id];
            const specSummary = summarizeSpec(spec);
            const startupFailure = startupFailures[row.id];
            const isExpanded = !!expandedRows[row.id] || !!startupFailure;
            const rowMenuItems = [
              ...(row.kind === "service"
                ? [
                    {
                      key: "tunnel",
                      label: "Tunnel locally",
                    },
                  ]
                : []),
              {
                key: isPublic ? "unexpose" : "expose",
                label: isPublic ? "Unexpose" : "Expose",
              },
              {
                key: "audit",
                label: "Audit with Codex",
              },
              {
                key: "logs",
                label: "Logs",
              },
              {
                key: "export",
                label: "Export",
              },
              {
                key: "edit",
                label: "Edit spec",
              },
              {
                type: "divider" as const,
              },
              {
                key: "delete",
                label: "Delete",
                danger: true,
              },
            ];
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
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>
                        {row.title || row.id}
                      </span>
                      <Tag>{row.kind || "service"}</Tag>
                      <Tag color={isRunning ? "green" : "default"}>
                        {isRunning ? "running" : "stopped"}
                      </Tag>
                      {isPublic ? <Tag color="gold">public</Tag> : null}
                    </div>
                    <div
                      style={{
                        opacity: 0.7,
                        fontFamily: "monospace",
                        fontSize: "12px",
                      }}
                    >
                      {row.id}
                    </div>
                  </div>
                  <Space wrap>
                    <Button
                      size="small"
                      onClick={() => toggleRowExpanded(row.id)}
                    >
                      {isExpanded ? "Hide details" : "Details"}
                    </Button>
                    <Button
                      size="small"
                      onClick={() => void openStatus(row)}
                      disabled={
                        !row.url &&
                        !buildPublicUrlFromExposure(row, publicAppPolicy)
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
                    <Dropdown
                      trigger={["click"]}
                      menu={{
                        items: rowMenuItems,
                        onClick: ({ key }) =>
                          onRowMenuAction(
                            row,
                            key as
                              | "tunnel"
                              | "expose"
                              | "unexpose"
                              | "audit"
                              | "logs"
                              | "export"
                              | "edit"
                              | "delete",
                          ),
                      }}
                    >
                      <Button
                        size="small"
                        loading={
                          submitting &&
                          rowAction?.appId === row.id &&
                          (rowAction.action === "expose" ||
                            rowAction.action === "unexpose" ||
                            rowAction.action === "audit")
                        }
                        disabled={submitting || transferBusy}
                      >
                        Actions
                      </Button>
                    </Dropdown>
                  </Space>
                </div>
                {isExpanded && specSummary.length > 0 ? (
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
                {isExpanded ? (
                  <div
                    style={{
                      marginTop: "8px",
                      padding: "8px 10px",
                      border: "1px solid #f0f0f0",
                      borderRadius: "8px",
                      background: "#fafafa",
                      display: "grid",
                      gap: "6px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "10px",
                        flexWrap: "wrap",
                      }}
                    >
                      <Space size={8} align="center">
                        <div style={{ fontWeight: 600, fontSize: "12px" }}>
                          Recent usage
                        </div>
                        <Button
                          size="small"
                          type="text"
                          loading={!!metricsRefreshing[row.id]}
                          onClick={() => void refreshMetricsForApp(row.id)}
                        >
                          Refresh
                        </Button>
                      </Space>
                      <div
                        style={{
                          display: "grid",
                          justifyItems: "end",
                          gap: "2px",
                        }}
                      >
                        <MetricsSparkline
                          values={
                            metrics?.history.map((item) => item.requests) ?? []
                          }
                        />
                        <div style={{ fontSize: "11px", opacity: 0.65 }}>
                          request trend
                        </div>
                      </div>
                    </div>
                    {metrics && metrics.totals.requests > 0 ? (
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns:
                            "repeat(auto-fit, minmax(148px, 1fr))",
                          gap: "8px",
                        }}
                      >
                        <MetricStat
                          label="Last hit"
                          value={
                            metrics.last_hit_ms ? (
                              <TimeAgo date={new Date(metrics.last_hit_ms)} />
                            ) : (
                              "never"
                            )
                          }
                        />
                        <MetricStat
                          label="Requests"
                          value={formatCount(metrics.totals.requests)}
                        />
                        <MetricStat
                          label="Bytes sent"
                          value={formatBytes(metrics.totals.bytes_sent)}
                        />
                        <MetricStat
                          label="Bytes received"
                          value={formatBytes(metrics.totals.bytes_received)}
                        />
                        <MetricStat
                          label="Active websockets"
                          value={formatCount(metrics.active_websockets)}
                        />
                        <MetricStat
                          label="Wake-ups"
                          value={formatCount(metrics.totals.wake_count)}
                        />
                        <MetricStat
                          label="Public / private"
                          value={`${formatCount(metrics.totals.public_requests)} / ${formatCount(metrics.totals.private_requests)}`}
                          subtle
                        />
                        <MetricStat
                          label="Latency p50 / p95"
                          value={`${formatLatency(metrics.totals.p50_ms)} / ${formatLatency(metrics.totals.p95_ms)}`}
                          subtle
                        />
                      </div>
                    ) : (
                      <div style={{ fontSize: "12px", opacity: 0.78 }}>
                        No app traffic recorded yet.
                      </div>
                    )}
                  </div>
                ) : null}
                {isExpanded && isPublic ? (
                  <div
                    style={{
                      marginTop: "8px",
                      fontSize: "12px",
                      opacity: 0.85,
                    }}
                  >
                    {buildPublicUrlFromExposure(row, publicAppPolicy) ? (
                      <>
                        Public URL:{" "}
                        <a
                          href={buildPublicUrlFromExposure(
                            row,
                            publicAppPolicy,
                          )}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {buildPublicUrlFromExposure(row, publicAppPolicy)}
                        </a>
                      </>
                    ) : buildPublicHostnameFromExposure(
                        row,
                        publicAppPolicy,
                      ) ? (
                      <>
                        Public Hostname:{" "}
                        {buildPublicHostnameFromExposure(row, publicAppPolicy)}
                      </>
                    ) : row.exposure?.random_subdomain ? (
                      <>
                        Public exposure active (subdomain label:{" "}
                        {row.exposure.random_subdomain})
                      </>
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
                {isExpanded && row.warnings?.length ? (
                  <Alert
                    style={{ marginTop: "8px" }}
                    type="warning"
                    showIcon
                    title={row.warnings.join(" ")}
                  />
                ) : null}
                {isExpanded && startupFailure ? (
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
                    title={`Failed to ${startupFailure.action === "start" ? "start" : "start after save"} '${row.title || row.id}'`}
                    description={
                      <div style={{ display: "grid", gap: "8px" }}>
                        <div>{startupFailure.errorMessage}</div>
                        {startupFailure.installHint ? (
                          <div style={{ opacity: 0.85 }}>
                            {startupFailure.installHint}
                          </div>
                        ) : null}
                        {startupFailure.installCommand ? (
                          <div
                            style={{
                              fontFamily: "monospace",
                              whiteSpace: "pre-wrap",
                              overflowWrap: "anywhere",
                              padding: "8px",
                              background: "#fafafa",
                              border: "1px solid #eee",
                              borderRadius: "6px",
                            }}
                          >
                            {startupFailure.installCommand}
                          </div>
                        ) : null}
                        <Space wrap>
                          <Button
                            size="small"
                            onClick={() => void onLogs(row.id)}
                          >
                            View full logs
                          </Button>
                          {canInstallWithCodex(startupFailure.preset) ? (
                            <Button
                              size="small"
                              onClick={() =>
                                openInstallWithCodex({
                                  preset: startupFailure.preset ?? {
                                    key: row.id,
                                    label: row.title || row.id,
                                    kind: row.kind ?? "service",
                                    id: row.id,
                                    title: row.title || row.id,
                                  },
                                  templateDetails:
                                    startupFailure.templateDetails,
                                  appId: row.id,
                                  action: startupFailure.action,
                                })
                              }
                              loading={
                                submittingToAgent || installWithCodexLaunching
                              }
                            >
                              Install with Codex
                            </Button>
                          ) : null}
                        </Space>
                        {startupFailure.stderrTail
                          ? renderLogTailBlock({
                              label: "stderr (tail)",
                              content: startupFailure.stderrTail,
                              background: "#fff7f7",
                            })
                          : null}
                        {startupFailure.stdoutTail
                          ? renderLogTailBlock({
                              label: "stdout (tail)",
                              content: startupFailure.stdoutTail,
                              background: "#fafafa",
                            })
                          : null}
                      </div>
                    }
                  />
                ) : null}
              </div>
            );
          })}
        </Space>
      </Card>
      {audit ? (
        <div
          style={{
            marginTop: "12px",
            border: "1px solid #e5e5e5",
            borderRadius: "8px",
            padding: "10px",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "8px",
            }}
          >
            <div style={{ fontWeight: 600 }}>
              Audit: {audit.title || audit.app_id}
            </div>
            <Button size="small" onClick={() => setAudit(undefined)}>
              Close
            </Button>
          </div>
          <div style={{ marginTop: "6px", fontSize: "12px", opacity: 0.85 }}>
            pass={audit.summary.pass}, warn={audit.summary.warn}, fail=
            {audit.summary.fail}
          </div>
          <ul
            style={{
              marginTop: "8px",
              marginBottom: "8px",
              paddingInlineStart: "18px",
            }}
          >
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
                navigator.clipboard
                  .writeText(audit.agent_prompt)
                  .catch(() => {})
              }
            >
              Copy Agent Prompt
            </Button>
            <Button
              size="small"
              type="primary"
              loading={submittingToAgent}
              onClick={() =>
                void sendAgentPrompt(
                  audit.agent_prompt,
                  "intent:app-server-audit",
                  { title: "Audit App Public Readiness" },
                )
              }
            >
              Send to Codex
            </Button>
          </Space>
        </div>
      ) : null}
      <Modal
        open={!!installWithCodexTarget}
        onCancel={() => setInstallWithCodexTarget(null)}
        title={
          installWithCodexTarget
            ? `Install with Codex: ${installWithCodexTarget.preset.label}`
            : "Install with Codex"
        }
        width={820}
        footer={[
          <Button
            key="close"
            onClick={() => setInstallWithCodexTarget(null)}
            disabled={installWithCodexLaunching}
          >
            Cancel
          </Button>,
          <Button
            key="launch"
            type="primary"
            loading={installWithCodexLaunching || submittingToAgent}
            onClick={() => void launchInstallWithCodex()}
          >
            {installWithCodexSnapshot
              ? "Create snapshot and open Codex"
              : "Open Codex"}
          </Button>,
        ]}
      >
        {installWithCodexTarget ? (
          <div style={{ display: "grid", gap: "12px" }}>
            <Paragraph style={{ marginBottom: 0 }}>
              Codex will open in this project with a launchpad-specific install
              prompt for <strong>{installWithCodexTarget.preset.label}</strong>.
              The prompt prefers systemwide installs, avoids snaps, and records
              rollback guidance.
            </Paragraph>
            {installWithCodexTarget.templateDetails ? (
              <Alert
                type="info"
                showIcon
                title="Current detection status"
                description={installWithCodexTarget.templateDetails}
              />
            ) : null}
            <div style={{ display: "grid", gap: "8px" }}>
              <Checkbox
                checked={installWithCodexSnapshot}
                onChange={(e) => setInstallWithCodexSnapshot(e.target.checked)}
              >
                Create a filesystem snapshot before installing (recommended)
              </Checkbox>
              {installWithCodexSnapshot ? (
                <Input
                  value={installWithCodexSnapshotName}
                  onChange={(e) =>
                    setInstallWithCodexSnapshotName(e.target.value)
                  }
                  placeholder="Snapshot name"
                />
              ) : null}
            </div>
            {installWithCodexTarget.preset.installCommand ? (
              <div>
                <div style={{ fontWeight: 600, marginBottom: "4px" }}>
                  Suggested starting command
                </div>
                <Typography.Paragraph
                  copyable={{
                    text: installWithCodexTarget.preset.installCommand,
                  }}
                  style={{
                    marginBottom: 0,
                    padding: "10px 12px",
                    border: "1px solid #eee",
                    borderRadius: "8px",
                    background: "#fafafa",
                    fontFamily: "monospace",
                    overflowWrap: "anywhere",
                  }}
                >
                  {installWithCodexTarget.preset.installCommand}
                </Typography.Paragraph>
              </div>
            ) : null}
            {installWithCodexTarget.preset.verifyCommands?.length ? (
              <div>
                <div style={{ fontWeight: 600, marginBottom: "4px" }}>
                  Verification
                </div>
                <Typography.Paragraph
                  copyable={{
                    text: installWithCodexTarget.preset.verifyCommands.join(
                      "\n",
                    ),
                  }}
                  style={{
                    marginBottom: 0,
                    padding: "10px 12px",
                    border: "1px solid #eee",
                    borderRadius: "8px",
                    background: "#fafafa",
                    fontFamily: "monospace",
                    overflowWrap: "anywhere",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {installWithCodexTarget.preset.verifyCommands.join("\n")}
                </Typography.Paragraph>
              </div>
            ) : null}
            <Collapse
              items={[
                {
                  key: "prompt-preview",
                  label: "Prompt preview",
                  children: (
                    <div style={{ display: "grid", gap: "8px" }}>
                      <div>
                        <Button
                          size="small"
                          onClick={() =>
                            navigator.clipboard
                              .writeText(installWithCodexPromptPreview)
                              .catch(() => {})
                          }
                        >
                          Copy Prompt
                        </Button>
                      </div>
                      <div
                        style={{
                          padding: "10px 12px",
                          border: "1px solid #eee",
                          borderRadius: "8px",
                          background: "#fafafa",
                        }}
                      >
                        <StaticMarkdown value={installWithCodexPromptPreview} />
                      </div>
                    </div>
                  ),
                },
              ]}
            />
          </div>
        ) : null}
      </Modal>
      <Modal
        open={!!localTunnelTarget}
        onCancel={() => setLocalTunnelTarget(null)}
        title={
          localTunnelTarget
            ? `Tunnel locally: ${localTunnelTarget.title || localTunnelTarget.id}`
            : "Tunnel locally"
        }
        width={720}
        footer={[
          <Button key="close" onClick={() => setLocalTunnelTarget(null)}>
            Close
          </Button>,
        ]}
      >
        {localTunnelTarget ? (
          <div style={{ display: "grid", gap: "12px" }}>
            <Paragraph style={{ marginBottom: 0 }}>
              Use the CoCalc CLI on your local computer to create a private
              tunnel to this app. The command will wake the project and app if
              needed, then print the local URL.
            </Paragraph>
            <div>
              <div style={{ fontWeight: 600, marginBottom: "4px" }}>
                Install CoCalc CLI
              </div>
              <a
                href={COCALC_CLI_DOWNLOAD_URL}
                target="_blank"
                rel="noreferrer"
              >
                {COCALC_CLI_DOWNLOAD_URL}
              </a>
            </div>
            {siteOrigin ? (
              <div style={{ fontSize: "12px", opacity: 0.78 }}>
                This tunnel targets: {siteOrigin}
              </div>
            ) : null}
            <div>
              <div style={{ fontWeight: 600, marginBottom: "4px" }}>
                Run locally
              </div>
              <Typography.Paragraph
                copyable={{
                  text: buildTunnelLocallyCommand(
                    project_id,
                    localTunnelTarget.id,
                  ),
                }}
                style={{
                  marginBottom: 0,
                  padding: "10px 12px",
                  border: "1px solid #eee",
                  borderRadius: "8px",
                  background: "#fafafa",
                  fontFamily: "monospace",
                  overflowWrap: "anywhere",
                }}
              >
                {buildTunnelLocallyCommand(project_id, localTunnelTarget.id)}
              </Typography.Paragraph>
            </div>
            <div style={{ fontSize: "12px", opacity: 0.78 }}>
              The end-user CLI login flow is still being improved. If the CLI is
              not authenticated locally yet, follow the auth prompts/help from
              the CLI first, then rerun the tunnel command.
            </div>
          </div>
        ) : null}
      </Modal>
      <Modal
        open={securityOpen}
        onCancel={() => setSecurityOpen(false)}
        title="Managed app security"
        width={760}
        footer={[
          <Button key="close" onClick={() => setSecurityOpen(false)}>
            Close
          </Button>,
        ]}
      >
        <StaticMarkdown value={APP_SECURITY_MARKDOWN} />
      </Modal>
      <Modal
        open={editSpecOpen}
        onCancel={closeEditSpecModal}
        width={980}
        title={
          editSpecTargetId ? `Edit spec: ${editSpecTargetId}` : "Edit app spec"
        }
        destroyOnClose={false}
        footer={[
          <Button
            key="close"
            onClick={closeEditSpecModal}
            disabled={editSpecSaving}
          >
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
            title={editSpecError}
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
              <div style={{ fontWeight: 600, marginBottom: "6px" }}>stdout</div>
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
                <StaticMarkdown
                  value={toFencedCodeBlock(logsData.stdout || "(empty)", "sh")}
                />
              </div>
            </div>
            <div>
              <div style={{ fontWeight: 600, marginBottom: "6px" }}>stderr</div>
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
                <StaticMarkdown
                  value={toFencedCodeBlock(logsData.stderr || "(empty)", "sh")}
                />
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
