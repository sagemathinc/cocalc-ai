import {
  AcpHarnessClient,
  HarnessError,
  disposeFailedHarness,
} from "./harness-client";
import type { HarnessBinding, HarnessLauncher } from "./harness-client";
import type { AcpAgent, AcpEvaluateRequest } from "./types";
import { parseAcpHarnessProfile } from "@cocalc/util/ai/runtime";
import { randomUUID } from "node:crypto";
import { harnessPrompt } from "./harness-context";
import type {
  CodexAttentionContext,
  CodexAttentionHandler,
} from "./codex-project";

/** One admitted conversation binding. The service must authorize each evaluation. */
export class HarnessAgent implements AcpAgent {
  private client?: AcpHarnessClient;
  private busy = false;
  private closed = false;
  private binding: HarnessBinding;
  private conversation: { path: string; threadId: string };
  private attentionContext?: CodexAttentionContext;

  constructor(
    binding: HarnessBinding,
    conversation: { path: string; threadId: string },
    private readonly launch: HarnessLauncher,
    private readonly attention?: CodexAttentionHandler,
  ) {
    this.binding = {
      ...binding,
      profile: parseAcpHarnessProfile(binding.profile),
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
    try {
      if (!this.client) {
        const client = await AcpHarnessClient.start(
          this.binding,
          this.launch,
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
        chat: request.chat,
        threadId: client.sessionId!,
        turnId: `acp-${randomUUID()}`,
        stream: request.stream,
      };
      await client.configure(request.runtime?.settings ?? {});
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
      await request.stream({
        type: "status",
        state: "running",
        threadId: client.sessionId,
      });
      await publishControls();
      let finalResponse = "";
      const result = await client.prompt(
        harnessPrompt(request),
        async (event) => {
          if (event.type === "message") {
            if (
              Buffer.byteLength(finalResponse) + Buffer.byteLength(event.text) >
              4 * 1024 * 1024
            )
              throw Error("ACP response exceeds persistence limit");
            finalResponse += event.text;
            await request.stream({
              type: "event",
              event: { type: "message", text: event.text, delta: true },
            });
          } else if (event.type === "thinking") {
            await request.stream({
              type: "event",
              event: { type: "thinking", text: event.text },
            });
          } else {
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
      await request.stream({
        type: "summary",
        finalResponse,
        threadId: client.sessionId,
      });
    } catch (error) {
      // Never silently start a fresh native session after an ambiguous failure.
      return await disposeFailedHarness(error, () => this.dispose());
    } finally {
      try {
        await this.attention?.runtimeClosed?.(this.attentionContext);
      } finally {
        this.attentionContext = undefined;
        this.busy = false;
      }
    }
  }

  hasRunningTurn(threadId: string): boolean {
    return this.busy && threadId === this.client?.sessionId;
  }

  async interruptOutstanding(threadId: string): Promise<boolean> {
    if (!this.hasRunningTurn(threadId)) return false;
    await this.client!.cancel();
    return true;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    await this.client?.dispose();
    await this.attention?.runtimeClosed?.(this.attentionContext);
  }
}
