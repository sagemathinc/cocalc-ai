/**
 * Project Codex backend primitives for the CLI.
 *
 * This module contains stdin/session-config parsing, ACP codex execution stream
 * handling, and device/auth helper RPC wrappers used by project codex commands.
 */
import { basename } from "node:path";

import { acpSubject } from "@cocalc/conat/ai/acp/server";
import type { AcpRequest, AcpStreamMessage } from "@cocalc/conat/ai/acp/types";
import type {
  CodexReasoningId,
  CodexSessionConfig,
  CodexSessionMode,
} from "@cocalc/util/ai/codex";

type ProjectIdentity = {
  project_id: string;
  title: string;
  host_id: string | null;
};

type RoutedClientState = {
  host_id: string;
  client?: {
    requestMany: (
      subject: string,
      request: unknown,
      options: { maxWait: number },
    ) => Promise<AsyncIterable<{ data: unknown }>>;
  };
};

type ProjectCodexExecResult = {
  project_id: string;
  session_id: string | null;
  thread_id: string | null;
  final_response: string;
  usage: Record<string, unknown> | null;
  last_seq: number;
  event_count: number;
  event_types: Record<string, number>;
  duration_ms: number;
};

type ProjectCodexDeviceAuthStatus = {
  id: string;
  state: "pending" | "completed" | "failed" | "canceled";
  verificationUrl?: string;
  userCode?: string;
  output?: string;
  startedAt?: number;
  updatedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
};

export type ProjectCodexOpsDeps<Ctx, Project extends ProjectIdentity> = {
  resolveProjectFromArgOrContext: (
    ctx: Ctx,
    projectIdentifier?: string,
    cwd?: string,
  ) => Promise<Project>;
  getOrCreateRoutedProjectHostClient: (
    ctx: Ctx,
    project: Project,
  ) => Promise<RoutedClientState>;
  projectHostHubCallAccount: <T>(
    ctx: Ctx,
    project: Project,
    name: string,
    args?: any[],
    timeout?: number,
    allowAuthRetry?: boolean,
  ) => Promise<T>;
  toIso: (value: unknown) => string | null;
  readFileLocal: (path: string, encoding: BufferEncoding) => Promise<string>;
};

function parseCodexReasoning(value?: string): CodexReasoningId | undefined {
  if (!value?.trim()) return undefined;
  const reasoning = value.trim().toLowerCase();
  if (
    reasoning === "low" ||
    reasoning === "medium" ||
    reasoning === "high" ||
    reasoning === "extra_high"
  ) {
    return reasoning;
  }
  throw new Error(
    `invalid --reasoning '${value}'; expected low|medium|high|extra_high`,
  );
}

function parseCodexSessionMode(value?: string): CodexSessionMode | undefined {
  if (!value?.trim()) return undefined;
  const mode = value.trim().toLowerCase();
  if (
    mode === "auto" ||
    mode === "read-only" ||
    mode === "workspace-write" ||
    mode === "full-access"
  ) {
    return mode;
  }
  throw new Error(
    `invalid --session-mode '${value}'; expected auto|read-only|workspace-write|full-access`,
  );
}

function summarizeCodexDeviceAuth(
  project: ProjectIdentity,
  status: ProjectCodexDeviceAuthStatus,
): Record<string, unknown> {
  return {
    project_id: project.project_id,
    project_title: project.title,
    auth_id: status.id,
    state: status.state,
    verification_url: status.verificationUrl ?? null,
    user_code: status.userCode ?? null,
    started_at: status.startedAt
      ? new Date(status.startedAt).toISOString()
      : null,
    updated_at: status.updatedAt
      ? new Date(status.updatedAt).toISOString()
      : null,
    exit_code: status.exitCode ?? null,
    signal: status.signal ?? null,
    error: status.error ?? null,
    output: status.output ?? "",
  };
}

export function createProjectCodexOps<Ctx, Project extends ProjectIdentity>(
  deps: ProjectCodexOpsDeps<Ctx, Project>,
) {
  const {
    resolveProjectFromArgOrContext,
    getOrCreateRoutedProjectHostClient,
    projectHostHubCallAccount,
    toIso,
    readFileLocal,
  } = deps;

  async function readAllStdin(): Promise<string> {
    if (process.stdin.isTTY) return "";
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  function buildCodexSessionConfig(opts: {
    model?: string;
    reasoning?: string;
    sessionMode?: string;
    workdir?: string;
  }): CodexSessionConfig | undefined {
    const config: CodexSessionConfig = {};
    if (opts.model?.trim()) {
      config.model = opts.model.trim();
    }
    const reasoning = parseCodexReasoning(opts.reasoning);
    if (reasoning) {
      config.reasoning = reasoning;
    }
    const sessionMode = parseCodexSessionMode(opts.sessionMode);
    if (sessionMode) {
      config.sessionMode = sessionMode;
    }
    if (opts.workdir?.trim()) {
      config.workingDirectory = opts.workdir.trim();
    }
    return Object.keys(config).length ? config : undefined;
  }

  async function projectCodexExecData({
    ctx,
    projectIdentifier,
    prompt,
    sessionId,
    config,
    onMessage,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    prompt: string;
    sessionId?: string;
    config?: CodexSessionConfig;
    onMessage?: (message: AcpStreamMessage) => Promise<void> | void;
    cwd?: string;
  }): Promise<ProjectCodexExecResult> {
    const project = await resolveProjectFromArgOrContext(
      ctx,
      projectIdentifier,
      cwd,
    );
    const routed = await getOrCreateRoutedProjectHostClient(ctx, project);
    if (!routed.client) {
      throw new Error(
        `internal error: routed client missing for host ${routed.host_id}`,
      );
    }

    const request: AcpRequest = {
      project_id: project.project_id,
      account_id: (ctx as any).accountId,
      prompt,
      ...(sessionId?.trim() ? { session_id: sessionId.trim() } : undefined),
      ...(config ? { config } : undefined),
    };
    const subject = acpSubject({ project_id: project.project_id });
    const startedAt = Date.now();
    const maxWait = Math.max(1_000, Number((ctx as any).timeoutMs ?? 0));

    let lastSeq = -1;
    let lastType: string | null = null;
    let eventCount = 0;
    const eventTypes: Record<string, number> = {};
    let usage: Record<string, unknown> | null = null;
    let finalResponse = "";
    let threadId: string | null = null;
    let sawSummary = false;
    let sawAnyMessage = false;

    const responses = await routed.client.requestMany(subject, request, {
      maxWait,
    });
    for await (const resp of responses) {
      if (resp.data == null) break;
      const message = resp.data as AcpStreamMessage;
      sawAnyMessage = true;
      lastType = `${(message as any)?.type ?? "unknown"}`;
      if (typeof message.seq === "number") {
        if (message.seq !== lastSeq + 1) {
          throw new Error("missed codex stream response");
        }
        lastSeq = message.seq;
      }
      if (onMessage) {
        await onMessage(message);
      }
      if (message.type === "error") {
        throw new Error(message.error || "codex exec failed");
      }
      if (message.type === "usage") {
        usage = ((message as any).usage ?? null) as Record<
          string,
          unknown
        > | null;
        continue;
      }
      if (message.type === "event") {
        eventCount += 1;
        const eventType = `${(message as any)?.event?.type ?? "unknown"}`;
        eventTypes[eventType] = (eventTypes[eventType] ?? 0) + 1;
        continue;
      }
      if (message.type === "summary") {
        sawSummary = true;
        finalResponse = `${message.finalResponse ?? ""}`;
        threadId =
          typeof message.threadId === "string" ? message.threadId : null;
        usage = ((message as any).usage ?? usage ?? null) as Record<
          string,
          unknown
        > | null;
      }
    }

    if (!sawSummary) {
      if (sawAnyMessage) {
        throw new Error(
          `codex exec ended before summary (last_type=${lastType ?? "unknown"}, last_seq=${lastSeq}); likely timed out waiting for completion -- try --stream and/or increase --timeout`,
        );
      }
      throw new Error(
        "codex exec returned no stream messages; check project-host ACP availability and routing",
      );
    }

    return {
      project_id: project.project_id,
      session_id: sessionId?.trim() || null,
      thread_id: threadId,
      final_response: finalResponse,
      usage,
      last_seq: lastSeq,
      event_count: eventCount,
      event_types: eventTypes,
      duration_ms: Date.now() - startedAt,
    };
  }

  function streamCodexHumanMessage(message: AcpStreamMessage): void {
    if (message.type === "status") {
      process.stderr.write(`[acp:${message.state}]\n`);
      return;
    }
    if (message.type === "event") {
      const event = (message as any).event;
      const kind = `${event?.type ?? "event"}`;
      if (
        (kind === "thinking" || kind === "message") &&
        typeof event?.text === "string"
      ) {
        process.stderr.write(event.text);
        if (!event.text.endsWith("\n")) {
          process.stderr.write("\n");
        }
        return;
      }
      if (kind === "terminal") {
        const phase = `${event?.phase ?? "unknown"}`;
        const terminalId = `${event?.terminalId ?? "terminal"}`;
        if (
          phase === "data" &&
          typeof event?.chunk === "string" &&
          event.chunk.length > 0
        ) {
          process.stderr.write(event.chunk);
          if (!event.chunk.endsWith("\n")) {
            process.stderr.write("\n");
          }
          return;
        }
        process.stderr.write(`[codex:terminal:${phase}] ${terminalId}\n`);
        return;
      }
      if (kind === "file") {
        process.stderr.write(
          `[codex:file] ${event?.operation ?? "op"} ${event?.path ?? ""}\n`,
        );
        return;
      }
      if (kind === "diff") {
        process.stderr.write(`[codex:diff] ${event?.path ?? ""}\n`);
        return;
      }
      process.stderr.write(`[codex:event] ${kind}\n`);
      return;
    }
    if (message.type === "usage") {
      const usage = (message as any).usage ?? {};
      process.stderr.write(`[codex:usage] ${JSON.stringify(usage)}\n`);
      return;
    }
    if (message.type === "summary") {
      process.stderr.write("[codex:summary]\n");
      return;
    }
    if (message.type === "error") {
      process.stderr.write(
        `[codex:error] ${message.error ?? "unknown error"}\n`,
      );
    }
  }

  async function projectCodexAuthStatusData({
    ctx,
    projectIdentifier,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    const project = await resolveProjectFromArgOrContext(
      ctx,
      projectIdentifier,
      cwd,
    );
    const [paymentSource, keyStatus, subscriptionCreds] = (await Promise.all([
      (ctx as any).hub.system.getCodexPaymentSource({
        project_id: project.project_id,
      }),
      (ctx as any).hub.system.getOpenAiApiKeyStatus({
        project_id: project.project_id,
      }),
      (ctx as any).hub.system.listExternalCredentials({
        provider: "openai",
        kind: "codex-subscription-auth-json",
        scope: "account",
      }),
    ])) as [any, any, any[]];

    return {
      project_id: project.project_id,
      project_title: project.title,
      payment_source: paymentSource?.source ?? "none",
      has_subscription: !!paymentSource?.hasSubscription,
      has_workspace_api_key: !!paymentSource?.hasProjectApiKey,
      has_account_api_key: !!paymentSource?.hasAccountApiKey,
      has_site_api_key: !!paymentSource?.hasSiteApiKey,
      shared_home_mode: paymentSource?.sharedHomeMode ?? null,
      account_api_key_configured: !!keyStatus?.account,
      account_api_key_updated: toIso(keyStatus?.account?.updated),
      account_api_key_last_used: toIso(keyStatus?.account?.last_used),
      project_api_key_configured: !!keyStatus?.project,
      project_api_key_updated: toIso(keyStatus?.project?.updated),
      project_api_key_last_used: toIso(keyStatus?.project?.last_used),
      subscription_credentials_count: Array.isArray(subscriptionCreds)
        ? subscriptionCreds.length
        : 0,
    };
  }

  async function projectCodexDeviceAuthStartData({
    ctx,
    projectIdentifier,
    wait,
    pollMs,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    wait: boolean;
    pollMs: number;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    const project = await resolveProjectFromArgOrContext(
      ctx,
      projectIdentifier,
      cwd,
    );
    let status = await projectHostHubCallAccount<ProjectCodexDeviceAuthStatus>(
      ctx,
      project,
      "projects.codexDeviceAuthStart",
      [{ project_id: project.project_id }],
    );

    if (wait && status.state === "pending") {
      const deadline = Date.now() + Number((ctx as any).timeoutMs ?? 0);
      while (status.state === "pending") {
        if (Date.now() >= deadline) {
          throw new Error(
            `timeout waiting for codex device auth completion (id=${status.id})`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        status = await projectHostHubCallAccount<ProjectCodexDeviceAuthStatus>(
          ctx,
          project,
          "projects.codexDeviceAuthStatus",
          [{ project_id: project.project_id, id: status.id }],
        );
      }
    }

    return summarizeCodexDeviceAuth(project, status);
  }

  async function projectCodexDeviceAuthStatusData({
    ctx,
    projectIdentifier,
    id,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    id: string;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    const project = await resolveProjectFromArgOrContext(
      ctx,
      projectIdentifier,
      cwd,
    );
    const status =
      await projectHostHubCallAccount<ProjectCodexDeviceAuthStatus>(
        ctx,
        project,
        "projects.codexDeviceAuthStatus",
        [{ project_id: project.project_id, id }],
      );
    return summarizeCodexDeviceAuth(project, status);
  }

  async function projectCodexDeviceAuthCancelData({
    ctx,
    projectIdentifier,
    id,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    id: string;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    const project = await resolveProjectFromArgOrContext(
      ctx,
      projectIdentifier,
      cwd,
    );
    const canceled = await projectHostHubCallAccount<{
      id: string;
      canceled: boolean;
    }>(ctx, project, "projects.codexDeviceAuthCancel", [
      { project_id: project.project_id, id },
    ]);
    const status =
      await projectHostHubCallAccount<ProjectCodexDeviceAuthStatus>(
        ctx,
        project,
        "projects.codexDeviceAuthStatus",
        [{ project_id: project.project_id, id }],
      );
    return {
      ...summarizeCodexDeviceAuth(project, status),
      canceled: canceled.canceled,
    };
  }

  async function projectCodexAuthUploadFileData({
    ctx,
    projectIdentifier,
    localPath,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    localPath: string;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    const project = await resolveProjectFromArgOrContext(
      ctx,
      projectIdentifier,
      cwd,
    );
    const content = await readFileLocal(localPath, "utf8");
    const uploaded = await projectHostHubCallAccount<{
      ok: true;
      codexHome: string;
      bytes: number;
      synced?: boolean;
    }>(ctx, project, "projects.codexUploadAuthFile", [
      {
        project_id: project.project_id,
        filename: basename(localPath),
        content,
      },
    ]);
    return {
      project_id: project.project_id,
      project_title: project.title,
      uploaded: uploaded.ok,
      bytes: uploaded.bytes,
      codex_home: uploaded.codexHome,
      synced: uploaded.synced ?? null,
    };
  }

  return {
    readAllStdin,
    buildCodexSessionConfig,
    projectCodexExecData,
    streamCodexHumanMessage,
    projectCodexAuthStatusData,
    projectCodexDeviceAuthStartData,
    projectCodexDeviceAuthStatusData,
    projectCodexDeviceAuthCancelData,
    projectCodexAuthUploadFileData,
  };
}
