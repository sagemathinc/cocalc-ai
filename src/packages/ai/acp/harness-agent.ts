import {
  AcpHarnessClient,
  HarnessError,
  disposeFailedHarness,
} from "./harness-client";
import type { HarnessBinding, HarnessLauncher } from "./harness-client";
import type {
  AcpAgent,
  AcpEvaluateRequest,
  AcpSteerRequest,
  AcpSteerResult,
} from "./types";
import {
  parseAcpHarnessCredential,
  parseAcpHarnessProfile,
} from "@cocalc/util/ai/runtime";
import { randomUUID } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import { isQualifiedClaudeCodeProfile } from "@cocalc/util/ai/qualified-harnesses";
import { harnessPrompt } from "./harness-context";
import { assertSameTurnPrincipal } from "./turn-principal";
import { normalizeCodexAsyncQuestions } from "./codex-attention";
import type {
  CodexAttentionContext,
  CodexAttentionHandler,
} from "./codex-project";

const logger = getLogger("ai:acp:harness-agent");

/** One admitted conversation binding. The service must authorize each evaluation. */
export class HarnessAgent implements AcpAgent {
  private client?: AcpHarnessClient;
  private busy = false;
  private closed = false;
  private interrupted = false;
  private binding: HarnessBinding;
  private conversation: { path: string; threadId: string };
  private attentionContext?: CodexAttentionContext;

  constructor(
    binding: HarnessBinding,
    conversation: { path: string; threadId: string },
    private readonly launch: HarnessLauncher,
    private readonly attention?: CodexAttentionHandler,
    private readonly validateAuthority?: (
      binding: HarnessBinding,
    ) => Promise<void>,
  ) {
    this.binding = {
      ...binding,
      profile: parseAcpHarnessProfile(binding.profile),
      credential: parseAcpHarnessCredential(
        binding.credential,
        binding.profile,
      ),
    };
    this.conversation = { ...conversation };
    if (!conversation.path || !conversation.threadId)
      throw Error("ACP conversation binding is required");
  }

  async evaluate(request: AcpEvaluateRequest): Promise<void> {
    if (
      request.project_id !== this.binding.projectId ||
      request.account_id !== this.binding.accountId ||
      request.chat?.project_id !== this.binding.projectId ||
      request.chat?.path !== this.conversation.path ||
      request.chat?.thread_id !== this.conversation.threadId
    )
      throw Error("ACP conversation binding mismatch");
    if (this.closed || this.busy) throw Error("ACP conversation is not idle");
    const credential = parseAcpHarnessCredential(
      request.harness_credential,
      this.binding.profile,
    );
    if (JSON.stringify(credential) !== JSON.stringify(this.binding.credential))
      throw Error("ACP credential binding mismatch");
    if (
      request.local_images?.length ||
      (request.config && Object.keys(request.config).length) ||
      (request.runtime_env && Object.keys(request.runtime_env).length) ||
      request.mentionReferences?.length ||
      request.readPendingGoal
    )
      throw new HarnessError(
        "unsupported",
        "Unsupported generic ACP request options",
      );
    if (
      this.client &&
      request.session_id &&
      request.session_id !== this.client.sessionId
    )
      throw Error("ACP native session binding mismatch");

    this.busy = true;
    this.interrupted = false;
    // The client whose CoCalc connector credential this turn issued.
    let connectorClient: AcpHarnessClient | undefined;
    try {
      await this.validateAuthority?.(this.binding);
      // The service preserves the authoritative empty reset marker. Missing
      // IDs can be sync lag; only an explicit reset retires a retained client.
      if (request.session_id === "" && this.client) {
        await this.client.dispose();
        this.client = undefined;
      }
      if (this.closed)
        throw Error("ACP conversation was disposed during reset");
      if (!this.client) {
        const client = await AcpHarnessClient.start(
          this.binding,
          async (binding) => {
            const process = await this.launch(binding);
            process.setAsyncQuestionHandler?.(async (input) => {
              const context = this.attentionContext;
              if (
                !context ||
                !this.attention ||
                !this.busy ||
                this.closed ||
                this.interrupted
              )
                throw Error("Async questions require an active agent turn");
              if (!this.client?.supportsSteering)
                throw Error(
                  "This adapter does not support asynchronous answers",
                );
              if (!input || typeof input !== "object" || Array.isArray(input))
                throw Error("Invalid async question request");
              const { request_id, questions } = input as Record<
                string,
                unknown
              >;
              if (
                typeof request_id !== "string" ||
                !/^[a-zA-Z0-9_-]{1,128}$/.test(request_id)
              )
                throw Error(
                  "Provide a unique request_id; reuse it only for an identical question",
                );
              const normalized = normalizeCodexAsyncQuestions({
                type: "agentMessage",
                delivery: "async",
                id: request_id,
                questions,
              });
              if (!normalized) throw Error("Provide one to three questions");
              await this.validateAuthority?.(this.binding);
              if (
                this.attentionContext !== context ||
                this.closed ||
                this.interrupted
              )
                throw Error("The question's turn has ended");
              const record = await this.attention.createAsyncQuestion({
                ...normalized,
                context,
              });
              return { question_id: record.attention_id, status: "pending" };
            });
            return process;
          },
          30_000,
          this.attention
            ? async (questions, signal, validate) => {
                const context = this.attentionContext;
                if (!context || signal.aborted)
                  throw Error("ACP attention is unavailable");
                const requestId = randomUUID();
                const answers = await this.attention!.requestSyncQuestion({
                  requestId,
                  itemId: requestId,
                  isBlocking: true,
                  questions,
                  context,
                  signal,
                });
                if (signal.aborted) throw Error("ACP question was canceled");
                validate(answers);
                await this.attention!.serverRequestResolved?.({
                  requestId,
                  context,
                });
                return answers;
              }
            : undefined,
          this.binding.credential.mode === "account-subscription"
            ? "claude-subscription-controller"
            : "default",
        );
        this.client = client;
        // Disposal may race with launch/initialization.
        if (this.closed) {
          await client.dispose();
          throw Error("ACP conversation was disposed during startup");
        }
        await client.open(request.session_id);
      }
      const client = this.client;
      this.attentionContext = {
        projectId: request.project_id,
        accountId: request.account_id,
        chat: { ...request.chat, harness_session_id: client.sessionId! },
        threadId: client.sessionId!,
        turnId: `acp-${randomUUID()}`,
        stream: request.stream,
      };
      const publishControls = () =>
        request.stream({
          type: "event",
          event: {
            type: "harness",
            source: "acp",
            kind: "controls",
            data: {
              profile: this.binding.profile,
              controls: client.controls,
            },
          },
        });
      try {
        await client.configure(request.runtime?.settings ?? {});
      } catch (error) {
        // A different credential or model can invalidate saved choices. Publish
        // the live catalog even on failure so the user can repair the selection.
        await publishControls();
        throw error;
      }
      let activityText = "";
      let finalResponse = "";
      let lastMessageId: string | undefined;
      let toolBoundary = false;
      if (this.interrupted)
        throw new HarnessError(
          "rejected",
          "ACP prompt interrupted before submission",
        );
      if (request.chat && isQualifiedClaudeCodeProfile(this.binding.profile)) {
        // The agent's scoped CoCalc connector credential lives only as long
        // as this turn (as for Codex); it is revoked in finally. Only the
        // qualified Claude Code harness is trusted with it.
        connectorClient = client;
        await client.beginConnectorTurn(request.chat);
      }
      const result = await client.prompt(
        harnessPrompt(request),
        async (event) => {
          if (event.type === "message") {
            if (!event.text) return;
            const messageId = event.messageId || undefined;
            // ACP chunks are token deltas, not paragraphs. Prefer explicit
            // message IDs; use tool boundaries only when an ID is unavailable.
            const newMessage =
              messageId && lastMessageId
                ? messageId !== lastMessageId
                : toolBoundary;
            let text = event.text;
            if (newMessage && activityText) {
              const trailing = activityText.match(/\n*$/)![0].length;
              const leading = text.match(/^\n*/)![0].length;
              text = "\n".repeat(Math.max(0, 2 - trailing - leading)) + text;
            }
            lastMessageId =
              messageId ?? (newMessage ? undefined : lastMessageId);
            toolBoundary = false;
            if (
              Buffer.byteLength(activityText) + Buffer.byteLength(text) >
              4 * 1024 * 1024
            )
              throw Error("ACP response exceeds persistence limit");
            activityText += text;
            // Activity keeps all commentary; the summary is the last assistant
            // message, not the whole turn. Do not copy activity-only separators.
            if (newMessage) finalResponse = "";
            finalResponse += event.text;
            await request.stream({
              type: "event",
              event: { type: "message", text, delta: true },
            });
          } else if (event.type === "thinking") {
            await request.stream({
              type: "event",
              event: { type: "thinking", text: event.text },
            });
          } else {
            if (
              event.type === "permission" ||
              (event.type === "update" &&
                (event.update.sessionUpdate === "tool_call" ||
                  event.update.sessionUpdate === "tool_call_update"))
            )
              toolBoundary = true;
            await request.stream({
              type: "event",
              event: {
                type: "harness",
                source: "acp",
                kind: event.type,
                data:
                  event.type === "update" ? { ...event.update } : { ...event },
              },
            });
          }
        },
        request.image_attachments ?? [],
        async () => {
          // Do not persist an empty native session when preflight/sign-in fails:
          // Claude does not create its resumable transcript until a prompt runs.
          await request.stream({
            type: "status",
            state: "running",
            threadId: client.sessionId,
          });
          await publishControls();
          if (this.interrupted)
            throw new HarnessError(
              "rejected",
              "ACP prompt interrupted before submission",
            );
        },
      );
      await publishControls();
      await request.stream({
        type: "event",
        event: {
          type: "harness",
          source: "acp",
          kind: "stop",
          data: { stopReason: result.stopReason },
        },
      });
      if (result.stopReason !== "end_turn") {
        throw new HarnessError(
          "rejected",
          `ACP prompt stopped: ${result.stopReason}`,
        );
      }
      // Finalize pending attention before publishing a successful completion.
      await this.attention?.runtimeClosed?.(this.attentionContext);
      if (this.interrupted)
        throw new HarnessError(
          "outcome_unknown",
          "ACP prompt completed after interruption was requested; cancellation was not confirmed",
        );
      await request.stream({
        type: "summary",
        finalResponse,
        threadId: client.sessionId,
      });
    } catch (error) {
      // Never silently start a fresh native session after an ambiguous failure.
      return await disposeFailedHarness(error, () => this.dispose());
    } finally {
      await connectorClient?.endConnectorTurn().catch((error) => {
        logger.warn("managed CoCalc connector revocation unconfirmed", {
          error: `${error}`,
        });
      });
      this.attentionContext = undefined;
      this.busy = false;
    }
  }

  hasRunningTurn(threadId: string): boolean {
    return this.busy && threadId === this.client?.sessionId;
  }

  async steer(
    threadId: string,
    request: AcpSteerRequest,
  ): Promise<AcpSteerResult> {
    if (request.session_id != null && request.session_id !== threadId)
      return { state: "missing" };
    if (threadId !== this.client?.sessionId) return { state: "missing" };
    assertSameTurnPrincipal(this.binding.accountId, request.account_id);
    if (
      request.project_id !== this.binding.projectId ||
      request.chat.project_id !== this.binding.projectId ||
      request.chat.path !== this.conversation.path ||
      request.chat.thread_id !== this.conversation.threadId
    )
      throw Object.assign(Error("ACP guidance conversation mismatch"), {
        code: "principal_mismatch",
      });
    if (
      !this.busy ||
      this.closed ||
      !this.client?.running ||
      !this.client.supportsSteering ||
      request.local_images?.length ||
      /(?:<img\b[^>]*\bsrc=|!\[[^\]]*\]\()[^\n]*\/blobs\//i.test(request.prompt)
    )
      return { state: "not_steerable", threadId };
    await this.validateAuthority?.(this.binding);
    const outcome = await this.client.steer(request.prompt);
    return {
      state: outcome === "injected" ? "steered" : "not_steerable",
      threadId,
    };
  }

  async interruptOutstanding(threadId: string): Promise<boolean> {
    if (!this.hasRunningTurn(threadId)) return false;
    this.interrupted = true;
    await this.client!.cancel();
    return true;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    try {
      await this.client?.dispose();
    } finally {
      await this.attention?.runtimeClosed?.(this.attentionContext);
    }
  }
}
