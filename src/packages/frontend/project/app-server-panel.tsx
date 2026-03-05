/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Checkbox, Divider, Input, Popconfirm, Select, Space, Spin, Tag } from "antd";
import type {
  AppPublicReadinessAudit,
  DetectedAppPort,
  ManagedAppStatus,
} from "@cocalc/conat/project/api/apps";
import { ErrorDisplay, Paragraph } from "@cocalc/frontend/components";
import {
  dispatchNavigatorPromptIntent,
  submitNavigatorPromptToCurrentThread,
} from "@cocalc/frontend/project/new/navigator-intents";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { withProjectHostBase } from "./host-url";

type AppKind = "service" | "static";

function normalizeError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(`${err}`);
}

function defaultBasePath(appId: string): string {
  const id = `${appId ?? ""}`.trim();
  return id ? `/apps/${id}` : "/apps/my-app";
}

export function AppServerPanel({
  project_id,
}: {
  project_id: string;
}) {
  const api = useMemo(
    () => webapp_client.conat_client.projectApi({ project_id }),
    [project_id],
  );
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
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submittingToAgent, setSubmittingToAgent] = useState<boolean>(false);
  const [actionAppId, setActionAppId] = useState<string>("");
  const [error, setError] = useState<Error | undefined>(undefined);
  const [audit, setAudit] = useState<AppPublicReadinessAudit | undefined>(
    undefined,
  );
  const [detected, setDetected] = useState<DetectedAppPort[]>([]);
  const [detecting, setDetecting] = useState<boolean>(false);
  const [rows, setRows] = useState<ManagedAppStatus[]>([]);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const next = await api.apps.listAppStatuses();
      setRows(next.sort((a, b) => a.id.localeCompare(b.id)));
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
    return {
      version: 1 as const,
      id,
      title: specTitle,
      kind: "static" as const,
      static: {
        root,
        index: `${staticIndex ?? ""}`.trim() || undefined,
        cache_control: `${staticCacheControl ?? ""}`.trim() || undefined,
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
    try {
      setSubmitting(true);
      setError(undefined);
      const spec = buildSpec();
      const { id } = await api.apps.upsertAppSpec(spec);
      let status = await api.apps.statusApp(id);
      if (startNow && spec.kind === "service") {
        status = await api.apps.ensureRunning(id, { timeout: 90_000, interval: 1000 });
      }
      await refresh();
      if (openWhenReady && status.state === "running") {
        await openStatus(status);
      }
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onStart(id: string) {
    try {
      setSubmitting(true);
      setError(undefined);
      await api.apps.ensureRunning(id, { timeout: 90_000, interval: 1000 });
      await refresh();
    } catch (err) {
      setError(normalizeError(err));
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

  return (
    <div>
      <Paragraph style={{ color: "#666", marginBottom: "8px" }}>
        Create a managed app spec, start it, and open the proxied URL.
      </Paragraph>
      <ErrorDisplay error={error} onClose={() => setError(undefined)} />
      <Space direction="vertical" style={{ width: "100%" }} size={8}>
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
          <Button type="primary" loading={submitting} onClick={() => void onCreate()}>
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
      <div style={{ fontWeight: 600, marginBottom: "8px" }}>Managed apps</div>
      {loading ? <Spin /> : null}
      {!loading && rows.length === 0 ? (
        <Alert type="info" showIcon message="No managed apps yet." />
      ) : null}
      <Space direction="vertical" style={{ width: "100%" }}>
        {rows.map((row) => {
          const isRunning = row.state === "running";
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
                </Space>
              </div>
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
    </div>
  );
}
