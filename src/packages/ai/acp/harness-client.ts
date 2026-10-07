import {
  ClientSideConnection,
  RequestError,
} from "@agentclientprotocol/sdk-v1";
import type {
  InitializeResponse,
  NewSessionResponse,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  StopReason,
  CreateElicitationRequest,
  CreateElicitationResponse,
} from "@agentclientprotocol/sdk-v1";
import type {
  AcpAttentionQuestion,
  AcpChatContext,
} from "@cocalc/conat/ai/acp/types";
import type { AcpImageAttachment } from "./types";
import { harnessQuestionForm } from "./harness-questions";
import { harnessSessionGuidance } from "./harness-context";
import type { Readable, Writable } from "node:stream";
import {
  parseAcpHarnessCredential,
  parseAcpHarnessProfile,
} from "@cocalc/util/ai/runtime";
import type {
  AcpHarnessCredential,
  AcpHarnessProfile,
} from "@cocalc/util/ai/runtime";
import { harnessTransport } from "./harness-transport";
import {
  diagnosticError,
  HarnessStderrDiagnostics,
  recordHarnessDiagnostic,
} from "./harness-diagnostics";
import {
  ACP_MAX_IMAGE_BYTES,
  ACP_MAX_TOTAL_IMAGE_BYTES,
  ACP_MAX_IMAGES,
  ACP_MAX_PROMPT_BYTES,
  ACP_MAX_OUTBOUND_FRAME_BYTES,
} from "@cocalc/util/ai/harness-limits";
import {
  defaultClaudeModel,
  harnessSessionControls,
  parseHarnessSessionSettings,
  resolveClaudeConfigValue,
} from "@cocalc/util/ai/harness-controls";
import type {
  HarnessSessionControls,
  HarnessSessionSettings,
} from "@cocalc/util/ai/harness-controls";
import { CLAUDE_CODE_QUALIFICATION } from "@cocalc/util/ai/qualified-harnesses";
import {
  isSupportedClaudeSubscriptionPlan,
  CLAUDE_SUBSCRIPTION_PLAN_ERROR,
} from "@cocalc/util/ai/claude-subscription-plan";

function unsupportedCallback(method: string): () => Promise<never> {
  return async () => {
    throw RequestError.methodNotFound(method);
  };
}

export interface HarnessProcess {
  /** Trusted launcher-owned instructions, never a user-supplied session option. */
  systemPromptAppend?: string;
  projectToolServerName?: string;
  /** Launcher decision: may the controller fetch arbitrary URLs itself? */
  webFetch?: boolean;
  stdout: Readable;
  stdin: Writable;
  stderr: Readable;
  /** Must resolve on process exit, including startup errors. */
  closed: Promise<void>;
  cancelTools?(): Promise<void>;
  resumeTools?(): void;
  /** End pending project job waits early so queued guidance is delivered. */
  releaseToolWaits?(): void;
  /** Trusted tool bridge callback, scoped to this process's admitted conversation. */
  setAsyncQuestionHandler?(handler: HarnessAsyncQuestionHandler): void;
  /**
   * Managed CoCalc connector: issue the agent's scoped credential for one
   * turn (if its connector is enabled) and revoke it when the turn ends.
   */
  beginConnectorTurn?(chat: AcpChatContext): Promise<void>;
  endConnectorTurn?(): Promise<void>;
  /** Launcher must terminate the execution boundary, including descendants. */
  stop(): Promise<void>;
  /**
   * Trusted launcher fact: the controller authenticates only with a
   * long-lived subscription token, which cannot report the account's plan.
   */
  subscriptionAuth?: "oauth-token";
}

export type HarnessAsyncQuestionHandler = (input: unknown) => Promise<{
  question_id: string;
  status: "pending";
}>;

export interface HarnessBinding {
  projectId: string;
  accountId: string;
  profile: AcpHarnessProfile;
  credential: AcpHarnessCredential;
}

export type HarnessLauncher = (
  binding: HarnessBinding,
  sessionId?: string,
) => Promise<HarnessProcess>;
export type HarnessQuestionHandler = (
  questions: AcpAttentionQuestion[],
  signal: AbortSignal,
  validate: (answers: Record<string, { answers: string[] }>) => void,
) => Promise<Record<string, { answers: string[] }>>;
export type HarnessEvent =
  | { type: "message" | "thinking"; text: string; messageId?: string }
  | { type: "update"; update: SessionNotification["update"] }
  | {
      type: "permission";
      toolCallId: string;
      outcome: "allowed" | "cancelled";
    };

export type HarnessSessionPolicy = "default" | "claude-subscription-controller";

const REQUEST_ACTIONS = {
  initialize: "start the agent runtime",
  "session/new": "open a session to load models and settings",
  "session/load": "resume this conversation",
  "session/fork": "copy this conversation",
  "session/set_mode": "apply the selected mode",
  "session/set_config_option": "apply the selected model or thinking level",
  "session/prompt": "process this message",
  "session/steering": "deliver guidance to the running agent",
  "session/cancel": "interrupt the running agent",
} as const;
type RequestMethod = keyof typeof REQUEST_ACTIONS;

const CLAUDE_AUTH_STATUS_METHOD = "_auth/status_update";

export function claudeAccountApiKeySessionMeta(
  systemPromptAppend?: string,
): Record<string, unknown> {
  return {
    ...(systemPromptAppend
      ? { systemPrompt: { append: systemPromptAppend } }
      : {}),
    claudeCode: {
      options: {
        // The pinned adapter resets Bedrock/Vertex when pinning a provider,
        // but does not yet reset Foundry. Settings env overrides process env.
        settings: { env: { CLAUDE_CODE_USE_FOUNDRY: "0" } },
      },
    },
  };
}

/**
 * Built-in Claude Code tools the isolated controller may use. None of them
 * touch the controller filesystem or run commands. WebSearch runs on
 * Anthropic's side. The Task* tools keep Claude's task list, which the
 * adapter reports as ACP plan updates. WebFetch downloads from the controller
 * itself, so only a launcher that knows the project has internet enables it.
 */
export const CLAUDE_CONTROLLER_TOOLS = [
  "WebSearch",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
] as const;

export function claudeSubscriptionSessionMeta(
  systemPromptAppend?: string,
  options: { projectToolServerName?: string; webFetch?: boolean } = {},
): Record<string, unknown> {
  const web = options.webFetch ? ["WebSearch", "WebFetch"] : ["WebSearch"];
  return {
    ...(systemPromptAppend
      ? { systemPrompt: { append: systemPromptAppend } }
      : {}),
    claudeCode: {
      options: {
        tools: [
          ...CLAUDE_CONTROLLER_TOOLS,
          ...(options.webFetch ? ["WebFetch"] : []),
        ],
        // CoCalc approves every call to these anyway. Pre-approving them
        // saves a permission round trip and a persisted event per call.
        allowedTools: [
          ...web,
          ...(options.projectToolServerName
            ? [`mcp__${options.projectToolServerName}`]
            : []),
        ],
        settingSources: [],
        skills: [],
        plugins: [],
        agents: {},
        mcpServers: {},
      },
    },
  };
}

export function isClaudeSubscriptionStatus(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  if (status.kind !== "account") return false;
  const account = status.account;
  if (!account || typeof account !== "object" || Array.isArray(account))
    return false;
  const plan = (account as Record<string, unknown>).plan;
  return isSupportedClaudeSubscriptionPlan(plan);
}

export class HarnessError extends Error {
  constructor(
    public readonly code:
      | "unavailable"
      | "outcome_unknown"
      | "unsupported"
      | "rejected",
    message: string,
    // The agent's process was killed (SIGKILL), e.g. at a memory limit.
    public readonly killed = false,
  ) {
    super(message);
  }
}

/** Preserve the primary failure without claiming unsuccessful cleanup stopped work. */
export async function disposeFailedHarness(
  error: unknown,
  dispose: () => Promise<void>,
): Promise<never> {
  try {
    await dispose();
  } catch {
    throw new HarnessError(
      error instanceof HarnessError ? error.code : "outcome_unknown",
      `${error instanceof HarnessError ? error.message : "ACP operation failed"}; runtime cleanup could not be confirmed. The harness may still be running.`,
    );
  }
  throw error;
}

/** One principal/profile-bound native session, independent of Codex auth/recovery. */
function assertValidImages(images: readonly AcpImageAttachment[]): void {
  if (
    images.length > ACP_MAX_IMAGES ||
    images.some(
      ({ data, mimeType }) =>
        !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
          mimeType,
        ) ||
        typeof data !== "string" ||
        data.length > Math.ceil(ACP_MAX_IMAGE_BYTES / 3) * 4 ||
        data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(data) ||
        Buffer.byteLength(data, "base64") > ACP_MAX_IMAGE_BYTES,
    )
  )
    throw new HarnessError(
      "rejected",
      "ACP accepts up to 8 PNG, JPEG, GIF or WebP images, at most 5 MiB each",
    );
  if (
    images.reduce(
      (bytes, { data }) => bytes + Buffer.byteLength(data, "base64"),
      0,
    ) > ACP_MAX_TOTAL_IMAGE_BYTES
  )
    throw new HarnessError(
      "rejected",
      "ACP images exceed the 10 MiB total limit",
    );
}

function promptBlocks(text: string, images: readonly AcpImageAttachment[]) {
  return [
    { type: "text" as const, text },
    ...images.map(({ data, mimeType }) => ({
      type: "image" as const,
      data,
      mimeType,
    })),
  ];
}

export class AcpHarnessClient {
  private connection: ClientSideConnection;
  private session?: NewSessionResponse;
  private active = false;
  private opening = false;
  private configuring = false;
  private canceled = false;
  private disposed = false;
  private failure?: Error;
  private readonly stderrDiagnostics = new HarnessStderrDiagnostics();
  private diagnosticId?: string;
  private pendingRequests = 0;
  private readonly startedAt = Date.now();
  private output: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private listener?: (event: HarnessEvent) => Promise<void>;
  private info!: InitializeResponse;
  private shutdown?: Promise<void>;
  private cancelTimer?: ReturnType<typeof setTimeout>;
  private questionAbort?: AbortController;
  private readonly binding: HarnessBinding;
  private readonly timeoutMs: number;
  private authStatus?: unknown;
  private finishAuthWait?: () => void;

  private constructor(
    binding: HarnessBinding,
    private process: HarnessProcess,
    timeoutMs: number,
    private readonly questionHandler?: HarnessQuestionHandler,
    private readonly sessionPolicy: HarnessSessionPolicy = "default",
  ) {
    this.binding = {
      ...binding,
      profile: parseAcpHarnessProfile(binding.profile),
      credential: parseAcpHarnessCredential(
        binding.credential,
        binding.profile,
      ),
    };
    this.timeoutMs = timeoutMs;
    process.stderr.on("data", (chunk) => this.stderrDiagnostics.append(chunk));
    process.stderr.on("error", () => this.fail(Error("ACP stderr failed")));
    process.stdin.on("error", () => this.fail(Error("ACP stdin closed")));
    this.connection = new ClientSideConnection(
      () => ({
        sessionUpdate: (notification) => this.onUpdate(notification),
        requestPermission: (request) => this.permission(request),
        createElicitation: (request) => this.question(request),
        extNotification: (method, params) => {
          if (method === CLAUDE_AUTH_STATUS_METHOD) {
            this.authStatus = params.authStatus;
            if (this.authStatus != null) this.finishAuthWait?.();
          }
        },
        // The SDK's legacy adapter otherwise reports empty success for absent
        // optional callbacks, even though we do not advertise these capabilities.
        readTextFile: unsupportedCallback("fs/read_text_file"),
        writeTextFile: unsupportedCallback("fs/write_text_file"),
        createTerminal: unsupportedCallback("terminal/create"),
        terminalOutput: unsupportedCallback("terminal/output"),
        releaseTerminal: unsupportedCallback("terminal/release"),
        waitForTerminalExit: unsupportedCallback("terminal/wait_for_exit"),
        killTerminal: unsupportedCallback("terminal/kill"),
      }),
      harnessTransport(process.stdout, process.stdin, (error) =>
        this.fail(error),
      ),
    );
    void process.closed.then(
      () => this.fail(Error("ACP process exited")),
      () => this.fail(Error("ACP process failed")),
    );
  }

  static async start(
    binding: HarnessBinding,
    launch: HarnessLauncher,
    timeoutMs = 30_000,
    questionHandler?: HarnessQuestionHandler,
    sessionPolicy: HarnessSessionPolicy = "default",
  ): Promise<AcpHarnessClient> {
    const profile = parseAcpHarnessProfile(binding.profile);
    const credential = parseAcpHarnessCredential(binding.credential, profile);
    if (!binding.projectId || !binding.accountId)
      throw Error("ACP principal binding is required");
    const client = new AcpHarnessClient(
      { ...binding, profile, credential },
      await launch({ ...binding, profile, credential }),
      timeoutMs,
      questionHandler,
      sessionPolicy,
    );
    try {
      client.info = await client.request(
        client.connection.initialize({
          protocolVersion: 1,
          clientInfo: { name: "cocalc", version: "1" },
          // No host filesystem, terminals, URL or secret/login callbacks.
          clientCapabilities: {
            ...(questionHandler ? { elicitation: { form: {} } } : {}),
            // The pinned Claude adapter resolves model defaults and applies
            // concrete effort to the SDK when this extension is negotiated.
            ...(profile.version === 2 && profile.id === "claude-code"
              ? {
                  _meta: {
                    jetbrains: {
                      air: { version: 1, capabilities: ["recommendedValue"] },
                    },
                  },
                }
              : {}),
          },
        }),
        "initialize",
      );
      if (client.info.protocolVersion !== 1)
        throw new HarnessError(
          "unsupported",
          "Harness did not negotiate ACP v1",
        );
      if (
        sessionPolicy === "claude-subscription-controller" &&
        (client.info.agentInfo?.name !==
          CLAUDE_CODE_QUALIFICATION.package.name ||
          client.info.agentInfo?.version !==
            CLAUDE_CODE_QUALIFICATION.package.version)
      )
        throw new HarnessError(
          "unsupported",
          "Subscription controller requires the qualified Claude adapter",
        );
      return client;
    } catch (error) {
      return await disposeFailedHarness(error, () => client.dispose());
    }
  }

  get capabilities(): InitializeResponse {
    return structuredClone(this.info);
  }
  get sessionId(): string | undefined {
    return this.session?.sessionId;
  }
  get running(): boolean {
    return this.active;
  }
  get supportsSteering(): boolean {
    return (
      (this.info._meta as { steering?: { supported?: boolean } } | undefined)
        ?.steering?.supported === true
    );
  }
  /** Issue this turn's CoCalc connector credential, if the launcher supports it. */
  async beginConnectorTurn(chat: AcpChatContext): Promise<void> {
    await this.process.beginConnectorTurn?.(chat);
  }

  /** Revoke the current turn's CoCalc connector credential. */
  async endConnectorTurn(): Promise<void> {
    await this.process.endConnectorTurn?.();
  }

  get controls(): HarnessSessionControls {
    return harnessSessionControls(this.session ?? {});
  }

  /** Clone persisted native context without loading it or starting inference. */
  async fork(sessionId: string): Promise<{ sessionId: string }> {
    this.assertRuntimeOpen();
    if (this.session || this.active || this.opening)
      throw new HarnessError("unavailable", "ACP fork requires a fresh client");
    if (!this.info.agentCapabilities?.sessionCapabilities?.fork)
      throw new HarnessError(
        "unsupported",
        "This harness does not support copying session context",
      );
    if (!sessionId.trim()) throw Error("Missing source session ID");
    this.opening = true;
    try {
      const result = await this.request(
        this.connection.unstable_forkSession({
          sessionId,
          cwd:
            this.sessionPolicy === "claude-subscription-controller"
              ? "/workspace"
              : this.binding.profile.cwd,
        }),
        "session/fork",
        false,
        true,
      );
      if (!result.sessionId?.trim() || result.sessionId === sessionId)
        throw new HarnessError(
          "rejected",
          "Harness did not return an independent copied session",
        );
      return { sessionId: result.sessionId };
    } finally {
      this.opening = false;
    }
  }

  /** Apply the admitted choices while idle; never mutate an in-flight turn. */
  async configure(settings: HarnessSessionSettings): Promise<void> {
    this.assertRuntimeOpen();
    if (!this.session || this.active || this.opening || this.configuring)
      throw new HarnessError(
        "unavailable",
        "ACP session must be idle and open",
      );
    const selected = parseHarnessSessionSettings(settings);
    // Claude omits the speed control for models without fast mode. A saved
    // explicit "off" remains satisfied, but never silently discard "on".
    const absentClaudeFastOff = (
      id: string,
      value: string,
      advertised: boolean,
    ) =>
      !advertised &&
      this.binding.profile.version === 2 &&
      this.binding.profile.id === "claude-code" &&
      id === "fast" &&
      value === "off";
    this.configuring = true;
    try {
      if (selected.modeId != null) {
        const control = this.controls.mode;
        if (!control?.options.some(({ value }) => value === selected.modeId))
          throw new HarnessError(
            "unsupported",
            "Selected ACP mode is not advertised by this session",
          );
        if (control.currentValue !== selected.modeId) {
          await this.request(
            this.connection.setSessionMode({
              sessionId: this.session.sessionId,
              modeId: selected.modeId,
            }),
            "session/set_mode",
          );
          this.session.modes!.currentModeId = selected.modeId;
        }
      }
      const claude =
        this.binding.profile.version === 2 &&
        this.binding.profile.id === "claude-code";
      if (claude && !selected.configOptions?.some(({ id }) => id === "model")) {
        // No model chosen: run CoCalc's default, not Claude Code's plan default.
        const model = this.controls.configOptions.find(
          ({ id }) => id === "model",
        );
        const value = model && defaultClaudeModel(model);
        if (value)
          selected.configOptions = [
            { id: "model", value },
            ...(selected.configOptions ?? []),
          ];
      }
      for (const choice of selected.configOptions ?? []) {
        const control = this.controls.configOptions.find(
          ({ id }) => id === choice.id,
        );
        if (absentClaudeFastOff(choice.id, choice.value, control != null))
          continue;
        if (control && claude)
          choice.value = resolveClaudeConfigValue(control, choice.value);
        if (!control?.options.some(({ value }) => value === choice.value))
          throw new HarnessError(
            "unsupported",
            `Selected ACP configuration ${JSON.stringify(choice.id)} value ${JSON.stringify(choice.value)} is not advertised by this session. Choose an available value in agent settings.`,
          );
        if (control.currentValue === choice.value) continue;
        const response = await this.request(
          this.connection.setSessionConfigOption({
            sessionId: this.session.sessionId,
            configId: choice.id,
            value: choice.value,
          }),
          "session/set_config_option",
        );
        this.session.configOptions = response.configOptions;
        // Changing a model can change the other controls. Use the returned
        // catalog for subsequent selections and verify the effective value.
        const effective = this.controls.configOptions.find(
          ({ id }) => id === choice.id,
        );
        if (effective?.currentValue !== choice.value)
          throw new HarnessError(
            "rejected",
            "Harness did not apply the selected ACP configuration value",
          );
      }
      // A later setting (such as model) can reset an earlier selection.
      // Do not start inference unless the complete admitted selection survives.
      if (selected.configOptions?.length) {
        const effective = this.controls.configOptions;
        if (
          selected.configOptions.some(({ id, value }) => {
            const control = effective.find((control) => control.id === id);
            return (
              !absentClaudeFastOff(id, value, control != null) &&
              control?.currentValue !== value
            );
          })
        )
          throw new HarnessError(
            "rejected",
            "Harness did not retain the complete selected ACP configuration",
          );
      }
    } finally {
      this.configuring = false;
    }
  }

  private fail(error: Error) {
    if (this.disposed) return;
    this.failure ??= error;
    // A pending request records its operation and rejection details in catch.
    // Idle exits have no request to do that, so record before sealing stderr.
    if (!this.pendingRequests)
      this.recordFailure(error, "runtime/failure", this.startedAt, false);
    void this.dispose().catch(() => {});
  }

  private recordFailure(
    error: unknown,
    method: RequestMethod | "runtime/failure",
    startedAt: number,
    protocolRejection: boolean,
  ): string {
    return (this.diagnosticId ??= recordHarnessDiagnostic({
      method,
      projectId: this.binding.projectId,
      accountId: this.binding.accountId,
      sessionId: this.session?.sessionId,
      elapsedMs: Date.now() - startedAt,
      protocolRejection,
      error,
      failure: this.failure,
      stderr: this.stderrDiagnostics,
    }));
  }

  private diagnosticSuffix(): string {
    return this.diagnosticId ? ` [Diagnostic ID: ${this.diagnosticId}]` : "";
  }

  private assertRuntimeOpen(): void {
    if (this.disposed || this.failure)
      throw new HarnessError(
        "unavailable",
        "ACP runtime is closed" + this.diagnosticSuffix(),
      );
  }

  private async request<T>(
    operation: Promise<T>,
    method: RequestMethod,
    prompt = false,
    mutation = false,
  ): Promise<T> {
    const startedAt = Date.now();
    this.pendingRequests++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = this.connection.closed.then(() => {
      throw Error("ACP connection closed");
    });
    const deadline = new Promise<never>((_, reject) => {
      if (!prompt)
        timer = setTimeout(
          () => reject(Error("ACP request timed out")),
          this.timeoutMs,
        );
    });
    try {
      // Observe every promise even when a prior output failure already closed
      // the runtime. Otherwise the close rejection can escape unhandled.
      return await Promise.race([
        operation,
        closed,
        deadline,
        ...(this.failure || this.disposed
          ? [Promise.reject(Error("ACP runtime unavailable"))]
          : []),
      ]);
    } catch (error) {
      const protocolRejection =
        !this.failure &&
        !this.connection.signal.aborted &&
        typeof (error as any)?.code === "number";
      const diagnosticId = this.recordFailure(
        error,
        method,
        startedAt,
        protocolRejection,
      );
      // An adapter whose agent process was SIGKILLed (e.g. by the kernel at
      // the project's memory limit) reports a generic internal error; the
      // kill shows in its stderr. Say so, and let the host recover.
      const killed = [
        ...diagnosticError(error).signals,
        ...this.stderrDiagnostics.snapshot().signals,
      ].includes("killed");
      this.fail(Error("ACP operation failed"));
      if (killed)
        throw new HarnessError(
          prompt || mutation ? "outcome_unknown" : "unavailable",
          `${this.agentName()}'s process was killed (SIGKILL) while it was working. [Diagnostic ID: ${diagnosticId}]`,
          true,
        );
      throw new HarnessError(
        protocolRejection
          ? "rejected"
          : prompt || mutation
            ? "outcome_unknown"
            : "unavailable",
        (protocolRejection
          ? this.rejectionMessage(error, method)
          : mutation
            ? "ACP copy outcome is uncertain; do not automatically retry"
            : prompt
              ? "ACP delivery or completion is uncertain; do not automatically resend this turn"
              : "ACP runtime unavailable or setup timed out") +
          ` [Diagnostic ID: ${diagnosticId}]`,
      );
    } finally {
      this.pendingRequests--;
      if (timer) clearTimeout(timer);
    }
  }

  private agentName(): string {
    return this.binding.profile.id === "claude-code" ||
      this.sessionPolicy === "claude-subscription-controller"
      ? "Claude"
      : "The agent";
  }

  private rejectionMessage(error: unknown, method: RequestMethod): string {
    const { code, data } = error as { code: number; data?: { cwd?: unknown } };
    const subscription =
      this.sessionPolicy === "claude-subscription-controller";
    const agent = this.agentName();
    let recovery: string;
    if (code === -32000) {
      recovery = subscription
        ? "Sign-in is required. Open agent settings and reconnect your Claude subscription."
        : "Authentication is required. Open agent settings and check the selected connection.";
    } else if (method === "session/load" && code === -32002) {
      recovery =
        "The saved session could not be opened. Reconnecting will not recreate a missing session. Contact the site administrator to check session storage and include the diagnostic code below; your chat history has been kept.";
    } else if (
      code === -32602 &&
      (method === "session/new" || method === "session/load") &&
      typeof data?.cwd === "string"
    ) {
      recovery = subscription
        ? "The isolated Claude workspace is unavailable. Ask the site administrator to update or repair the Claude runtime; changing your project directory will not fix this."
        : "The working directory is unavailable. Use the folder control to select an existing project directory, then retry.";
    } else if (
      method === "session/set_mode" ||
      method === "session/set_config_option"
    ) {
      recovery =
        "Open agent settings, reload the available choices, and select a supported value.";
    } else {
      recovery =
        code === -32602 || code === -32601
          ? "The installed integration rejected the request. Ask the site administrator to update the agent runtime and include the diagnostic code below."
          : method === "session/prompt" || method === "session/fork"
            ? "Check the agent activity before trying again. If this persists, report this error to the site administrator with the diagnostic code below."
            : "Contact the site administrator to check the agent runtime and include the diagnostic code below.";
    }
    // Protocol messages/data may contain credentials or arbitrary process output.
    // Only expose our operation name, numeric code, and fixed recovery guidance.
    return `${agent} could not ${REQUEST_ACTIONS[method]}. ${recovery} (ACP ${method}, code ${code})`;
  }

  async open(sessionId?: string): Promise<NewSessionResponse> {
    this.assertRuntimeOpen();
    if (this.session || this.active || this.opening)
      throw Error("ACP session is already open or opening");
    this.opening = true;
    try {
      const projectToolServerName =
        this.process.projectToolServerName ?? "cocalc_project";
      const params = {
        cwd:
          this.sessionPolicy === "claude-subscription-controller"
            ? "/workspace"
            : this.binding.profile.cwd,
        mcpServers:
          this.sessionPolicy === "claude-subscription-controller"
            ? [
                {
                  name: projectToolServerName,
                  command: "/opt/cocalc/bin/node",
                  args: ["/run/cocalc/agent-tools/bridge.cjs"],
                  env: [],
                },
              ]
            : [],
        ...(this.sessionPolicy === "claude-subscription-controller"
          ? {
              _meta: claudeSubscriptionSessionMeta(
                [this.process.systemPromptAppend, harnessSessionGuidance(true)]
                  .filter(Boolean)
                  .join("\n\n"),
                {
                  projectToolServerName,
                  webFetch: this.process.webFetch,
                },
              ),
            }
          : this.binding.credential.mode === "account-api-key"
            ? {
                _meta: claudeAccountApiKeySessionMeta(
                  harnessSessionGuidance(false),
                ),
              }
            : {
                _meta: {
                  systemPrompt: { append: harnessSessionGuidance(false) },
                },
              }),
      };
      if (sessionId) {
        if (!this.info.agentCapabilities?.loadSession)
          throw new HarnessError(
            "unsupported",
            "Harness cannot resume sessions",
          );
        // Loading replays history, not a new response. onUpdate ignores this phase.
        try {
          const loaded = await this.request(
            this.connection.loadSession({ ...params, sessionId }),
            "session/load",
          );
          this.session = { ...loaded, sessionId };
        } catch (error) {
          if (
            this.sessionPolicy === "claude-subscription-controller" &&
            error instanceof HarnessError &&
            error.code === "rejected"
          ) {
            throw new HarnessError(
              "rejected",
              `${error.message} The saved conversation has not been replaced.`,
            );
          }
          throw error;
        }
      } else {
        this.session = await this.request(
          this.connection.newSession(params),
          "session/new",
        );
      }
      return structuredClone(this.session);
    } finally {
      this.opening = false;
    }
  }

  async prompt(
    text: string,
    listener: (event: HarnessEvent) => Promise<void>,
    images: readonly AcpImageAttachment[] = [],
    beforeSend?: () => Promise<void>,
  ): Promise<{ stopReason: StopReason }> {
    this.assertRuntimeOpen();
    if (!this.session || this.active || this.configuring)
      throw Error("ACP session must be idle and open");
    if (
      typeof text !== "string" ||
      !text.trim() ||
      Buffer.byteLength(text) > ACP_MAX_PROMPT_BYTES
    )
      throw Error("Invalid ACP prompt size");
    assertValidImages(images);
    const params = {
      sessionId: this.session.sessionId,
      prompt: promptBlocks(text, images),
    };
    // Reject before handing the request to the SDK or granting tool execution.
    // Reserve space for the SDK's JSON-RPC method, ID and envelope.
    if (
      Buffer.byteLength(JSON.stringify(params)) >
      ACP_MAX_OUTBOUND_FRAME_BYTES - 1024
    )
      throw new HarnessError(
        "rejected",
        "ACP prompt exceeds the outgoing message limit",
      );
    this.active = true;
    this.canceled = false;
    this.listener = listener;
    try {
      if (this.sessionPolicy === "claude-subscription-controller")
        await this.verifySubscriptionIdentity();
      await beforeSend?.();
      if (this.canceled || this.disposed || this.failure)
        throw new HarnessError(
          "rejected",
          "ACP prompt interrupted before submission",
        );
      this.process.resumeTools?.();
      const result = await this.request(
        this.connection.prompt(params),
        "session/prompt",
        true,
      );
      await this.request(this.output, "session/prompt", true);
      if (this.failure)
        throw new HarnessError(
          "outcome_unknown",
          "ACP output could not be persisted",
        );
      return { stopReason: result.stopReason };
    } finally {
      if (this.cancelTimer) clearTimeout(this.cancelTimer);
      this.cancelTimer = undefined;
      this.active = false;
      this.questionAbort?.abort();
      this.listener = undefined;
    }
  }

  private async verifySubscriptionIdentity(): Promise<void> {
    // The adapter's initial identity probe is asynchronous and can finish
    // after session/new. Reserve the turn, but do not send it or enable tools.
    if (this.authStatus == null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => done(), Math.min(this.timeoutMs, 6_000));
        const done = () => {
          clearTimeout(timer);
          this.finishAuthWait = undefined;
          resolve();
        };
        this.finishAuthWait = done;
      });
    }
    if (this.canceled || this.disposed || this.failure)
      throw new HarnessError(
        "unavailable",
        "Claude startup was interrupted. No message was sent.",
      );
    if (isClaudeSubscriptionStatus(this.authStatus)) return;
    // A token-authenticated controller reports no plan, so the adapter says
    // "none" (or an account). Any other billing method is still refused.
    if (this.process.subscriptionAuth === "oauth-token") {
      const kind = (this.authStatus as { kind?: unknown } | undefined)?.kind;
      if (kind === "none" || kind === "account") return;
    }
    const status = this.authStatus as
      | { kind?: string; account?: { plan?: unknown } }
      | undefined;
    let message: string;
    if (status?.kind === "none")
      message =
        "Claude is not signed in. Open Claude settings and choose Reconnect Claude. Your conversation is preserved.";
    else if (
      status?.kind === "account" &&
      typeof status.account?.plan === "string" &&
      status.account.plan.trim()
    )
      message = CLAUDE_SUBSCRIPTION_PLAN_ERROR;
    else if (["api_key", "gateway", "external"].includes(status?.kind ?? ""))
      message =
        "Claude reported a different billing method instead of your subscription. Open Claude settings and reconnect the selected subscription. No message was sent or billed.";
    else
      message =
        "Claude has not reported a verifiable subscription identity yet. No message was sent or billed. Retry; if this persists, reconnect in Claude settings or contact the site administrator.";
    throw new HarnessError(
      status == null ? "unavailable" : "rejected",
      message,
    );
  }

  /** Only inject into a running prompt; never let an idle steer start a detached turn. */
  async steer(
    text: string,
    images: readonly AcpImageAttachment[] = [],
  ): Promise<"injected" | "idle"> {
    if (
      !this.supportsSteering ||
      !this.active ||
      !this.session ||
      this.finishAuthWait
    )
      return "idle";
    if (
      typeof text !== "string" ||
      !text.trim() ||
      Buffer.byteLength(text) > 512 * 1024
    )
      throw Error("Invalid ACP guidance size");
    assertValidImages(images);
    const params = {
      sessionId: this.session.sessionId,
      prompt: promptBlocks(text, images),
      _meta: { steering: { idleBehavior: "promptRequired" } },
    };
    if (
      Buffer.byteLength(JSON.stringify(params)) >
      ACP_MAX_OUTBOUND_FRAME_BYTES - 1024
    )
      throw new HarnessError(
        "rejected",
        "ACP guidance exceeds the outgoing message limit",
      );
    const response = (await this.request(
      this.connection.extMethod("_session/steering", params),
      "session/steering",
      true,
    )) as { outcome?: string };
    if (response.outcome === "injected") {
      // Claude reads guidance at its next step, which a long job wait delays.
      this.process.releaseToolWaits?.();
      return "injected";
    }
    if (response.outcome === "promptRequired") return "idle";
    throw new HarnessError("outcome_unknown", "Unexpected ACP guidance result");
  }

  private onUpdate(notification: SessionNotification): Promise<void> {
    if (!this.session) return Promise.resolve();
    if (notification.sessionId !== this.session.sessionId) {
      this.fail(Error("ACP update has wrong session"));
      return Promise.resolve();
    }
    const update = notification.update;
    if (update.sessionUpdate === "config_option_update") {
      this.session.configOptions = update.configOptions;
    } else if (
      update.sessionUpdate === "current_mode_update" &&
      this.session.modes
    ) {
      this.session.modes.currentModeId = update.currentModeId;
    }
    if (!this.active) return Promise.resolve();
    if (
      (update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "agent_thought_chunk") &&
      update.content.type === "text"
    ) {
      return this.emit({
        type:
          update.sessionUpdate === "agent_message_chunk"
            ? "message"
            : "thinking",
        text: update.content.text,
        messageId: update.messageId ?? undefined,
      });
    }
    return this.emit({ type: "update", update });
  }

  private emit(event: HarnessEvent): Promise<void> {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (this.pendingBytes + bytes > 4 * 1024 * 1024) {
      this.fail(Error("ACP output consumer exceeded buffer limit"));
      return Promise.resolve();
    }
    this.pendingBytes += bytes;
    const listener = this.listener;
    this.output = this.output.then(async () => {
      try {
        if (!this.failure) await listener?.(event);
      } catch {
        this.fail(Error("ACP output consumer failed"));
      } finally {
        this.pendingBytes -= bytes;
      }
    });
    return this.output;
  }

  private async permission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (
      !this.active ||
      this.canceled ||
      this.disposed ||
      request.sessionId !== this.session?.sessionId
    ) {
      return { outcome: { outcome: "cancelled" } };
    }
    const option = request.options.find(({ kind }) => kind === "allow_once");
    await this.emit({
      type: "permission",
      toolCallId: request.toolCall.toolCallId,
      outcome: option ? "allowed" : "cancelled",
    });
    // Cancellation can arrive while persistence of the permission event is pending.
    if (!option || this.canceled || this.disposed)
      return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: option.optionId } };
  }

  private async question(
    request: CreateElicitationRequest,
  ): Promise<CreateElicitationResponse> {
    if (
      !this.questionHandler ||
      !this.active ||
      this.canceled ||
      this.disposed ||
      this.questionAbort
    )
      throw new HarnessError(
        "unsupported",
        "ACP task questions are unavailable",
      );
    const form = harnessQuestionForm(request);
    if (form.sessionId !== this.session?.sessionId)
      throw new HarnessError("rejected", "ACP question has wrong session");
    const controller = new AbortController();
    this.questionAbort = controller;
    let onAbort: () => void = () => {};
    try {
      const cancelled = new Promise<undefined>((resolve) => {
        onAbort = () => resolve(undefined);
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      const answers = await Promise.race([
        this.questionHandler(form.questions, controller.signal, form.response),
        cancelled,
      ]);
      if (
        !answers ||
        controller.signal.aborted ||
        !this.active ||
        this.canceled ||
        this.disposed
      )
        return { action: "cancel" };
      return form.response(answers);
    } catch {
      if (controller.signal.aborted) return { action: "cancel" };
      throw new HarnessError(
        "rejected",
        "ACP task question could not be completed",
      );
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
      if (this.questionAbort === controller) this.questionAbort = undefined;
    }
  }

  async cancel(): Promise<void> {
    if (!this.active || !this.session) return;
    this.canceled = true;
    this.finishAuthWait?.();
    this.questionAbort?.abort();
    this.cancelTimer ??= setTimeout(
      () => this.fail(Error("ACP cancellation was not confirmed")),
      this.timeoutMs,
    );
    await Promise.all([
      this.process.cancelTools?.(),
      this.request(
        this.connection.cancel({ sessionId: this.session.sessionId }),
        "session/cancel",
      ),
    ]);
  }

  dispose(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.stderrDiagnostics.seal();
    this.disposed = true;
    this.finishAuthWait?.();
    this.questionAbort?.abort();
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.process.stdin.destroy();
    this.process.stdout.destroy();
    this.process.stderr.destroy();
    this.shutdown = Promise.resolve()
      .then(() => this.process.stop())
      .catch((error) => {
        // Keep inference disabled, but allow a later cleanup attempt to retry
        // transient container-removal failures instead of caching rejection.
        this.shutdown = undefined;
        throw error;
      });
    return this.shutdown;
  }
}
