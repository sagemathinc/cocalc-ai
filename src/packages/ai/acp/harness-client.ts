import { ClientSideConnection } from "@agentclientprotocol/sdk-v1";
import type {
  InitializeResponse,
  NewSessionResponse,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  StopReason,
} from "@agentclientprotocol/sdk-v1";
import type { Readable, Writable } from "node:stream";
import { parseAcpHarnessProfile } from "@cocalc/util/ai/runtime";
import type { AcpHarnessProfile } from "@cocalc/util/ai/runtime";
import { harnessTransport } from "./harness-transport";

export interface HarnessProcess {
  stdout: Readable;
  stdin: Writable;
  stderr: Readable;
  /** Must resolve on process exit, including startup errors. */
  closed: Promise<void>;
  /** Launcher must terminate the execution boundary, including descendants. */
  stop(): Promise<void>;
}

export interface HarnessBinding {
  projectId: string;
  accountId: string;
  profile: AcpHarnessProfile;
}

export type HarnessLauncher = (
  binding: HarnessBinding,
) => Promise<HarnessProcess>;
export type HarnessEvent =
  | { type: "message" | "thinking"; text: string; messageId?: string }
  | { type: "update"; update: SessionNotification["update"] }
  | {
      type: "permission";
      toolCallId: string;
      outcome: "allowed" | "cancelled";
    };

export class HarnessError extends Error {
  constructor(
    public readonly code:
      | "unavailable"
      | "outcome_unknown"
      | "unsupported"
      | "rejected",
    message: string,
  ) {
    super(message);
  }
}

/** One principal/profile-bound native session, independent of Codex auth/recovery. */
export class AcpHarnessClient {
  private connection: ClientSideConnection;
  private session?: NewSessionResponse;
  private active = false;
  private opening = false;
  private canceled = false;
  private disposed = false;
  private failure?: Error;
  private output: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private listener?: (event: HarnessEvent) => Promise<void>;
  private info!: InitializeResponse;
  private shutdown?: Promise<void>;
  private cancelTimer?: ReturnType<typeof setTimeout>;
  private readonly binding: HarnessBinding;
  private readonly timeoutMs: number;

  private constructor(
    binding: HarnessBinding,
    private process: HarnessProcess,
    timeoutMs: number,
  ) {
    this.binding = {
      ...binding,
      profile: parseAcpHarnessProfile(binding.profile),
    };
    this.timeoutMs = timeoutMs;
    // Drain stderr, but never copy untrusted process output into chat or logs.
    process.stderr.on("data", () => {});
    process.stderr.on("error", () => this.fail(Error("ACP stderr failed")));
    process.stdin.on("error", () => this.fail(Error("ACP stdin closed")));
    this.connection = new ClientSideConnection(
      () => ({
        sessionUpdate: (notification) => this.onUpdate(notification),
        requestPermission: (request) => this.permission(request),
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
  ): Promise<AcpHarnessClient> {
    const profile = parseAcpHarnessProfile(binding.profile);
    if (!binding.projectId || !binding.accountId)
      throw Error("ACP principal binding is required");
    const client = new AcpHarnessClient(
      { ...binding, profile },
      await launch({ ...binding, profile }),
      timeoutMs,
    );
    try {
      client.info = await client.request(
        client.connection.initialize({
          protocolVersion: 1,
          clientInfo: { name: "cocalc", version: "1" },
          clientCapabilities: {}, // No host filesystem, terminals, or secret/login callbacks.
        }),
      );
      if (client.info.protocolVersion !== 1)
        throw new HarnessError(
          "unsupported",
          "Harness did not negotiate ACP v1",
        );
      return client;
    } catch (error) {
      await client.dispose();
      throw error;
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

  private fail(error: Error) {
    this.failure ??= error;
    void this.dispose().catch(() => {});
  }

  private async request<T>(operation: Promise<T>, prompt = false): Promise<T> {
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
      if (this.failure || this.disposed) throw Error("ACP runtime unavailable");
      return await Promise.race([operation, closed, deadline]);
    } catch (error) {
      const protocolRejection =
        !this.failure &&
        !this.connection.signal.aborted &&
        typeof (error as any)?.code === "number";
      this.fail(Error("ACP operation failed"));
      throw new HarnessError(
        protocolRejection
          ? "rejected"
          : prompt
            ? "outcome_unknown"
            : "unavailable",
        protocolRejection
          ? "Harness rejected the ACP request; check its project configuration"
          : prompt
            ? "ACP delivery or completion is uncertain; do not automatically resend this turn"
            : "ACP runtime unavailable or setup timed out",
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async open(sessionId?: string): Promise<NewSessionResponse> {
    if (this.session || this.active || this.opening)
      throw Error("ACP session is already open or opening");
    if (this.disposed)
      throw new HarnessError("unavailable", "ACP runtime is closed");
    this.opening = true;
    try {
      const params = { cwd: this.binding.profile.cwd, mcpServers: [] };
      if (sessionId) {
        if (!this.info.agentCapabilities?.loadSession)
          throw new HarnessError(
            "unsupported",
            "Harness cannot resume sessions",
          );
        // Loading replays history, not a new response. onUpdate ignores this phase.
        const loaded = await this.request(
          this.connection.loadSession({ ...params, sessionId }),
        );
        this.session = { ...loaded, sessionId };
      } else {
        this.session = await this.request(this.connection.newSession(params));
      }
      return structuredClone(this.session);
    } finally {
      this.opening = false;
    }
  }

  async prompt(
    text: string,
    listener: (event: HarnessEvent) => Promise<void>,
  ): Promise<{ stopReason: StopReason }> {
    if (this.disposed || this.failure)
      throw new HarnessError("unavailable", "ACP runtime is closed");
    if (!this.session || this.active)
      throw Error("ACP session must be idle and open");
    if (
      typeof text !== "string" ||
      !text.trim() ||
      Buffer.byteLength(text) > 512 * 1024
    )
      throw Error("Invalid ACP prompt size");
    this.active = true;
    this.canceled = false;
    this.listener = listener;
    try {
      const result = await this.request(
        this.connection.prompt({
          sessionId: this.session.sessionId,
          prompt: [{ type: "text", text }],
        }),
        true,
      );
      await this.request(this.output, true);
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
      this.listener = undefined;
    }
  }

  private onUpdate(notification: SessionNotification): Promise<void> {
    if (!this.active || !this.session) return Promise.resolve();
    if (notification.sessionId !== this.session.sessionId) {
      this.fail(Error("ACP update has wrong session"));
      return Promise.resolve();
    }
    const update = notification.update;
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

  async cancel(): Promise<void> {
    if (!this.active || !this.session) return;
    this.canceled = true;
    this.cancelTimer ??= setTimeout(
      () => this.fail(Error("ACP cancellation was not confirmed")),
      this.timeoutMs,
    );
    await this.request(
      this.connection.cancel({ sessionId: this.session.sessionId }),
    );
  }

  dispose(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.disposed = true;
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.process.stdin.destroy();
    this.process.stdout.destroy();
    this.process.stderr.destroy();
    this.shutdown = this.process.stop();
    return this.shutdown;
  }
}
