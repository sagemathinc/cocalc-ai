import {
  normalizeCodexGoal,
  validateCodexGoalCommand,
} from "@cocalc/util/ai/codex-goal";
import type {
  CodexGoalCommand,
  CodexGoalEvent,
  CodexGoalSnapshot,
} from "@cocalc/util/ai/codex-goal";

// Attached only to a runtime that is already executing a requested turn.
// Polling reads the local chat replica; it never starts a project or process.
export class CodexGoalSync {
  private timer?: ReturnType<typeof setInterval>;
  private busy?: Promise<void>;
  private stopped = false;
  private seen = new Set<string>();
  private dirty = false;
  private supported = true;
  private last?: CodexGoalSnapshot;

  constructor(
    private readonly options: {
      sessionId: string;
      request: (method: string, params: any, timeout: number) => Promise<any>;
      readPending?: () => CodexGoalCommand | undefined;
      emit: (event: CodexGoalEvent) => Promise<void>;
    },
  ) {}

  async start() {
    await this.tick("start");
    this.timer = setInterval(() => {
      void this.tick("update").catch(() => {});
    }, 1000);
    this.timer.unref?.();
  }

  changed(sessionId: string) {
    if (sessionId === this.options.sessionId) this.dirty = true;
  }

  async isActive(): Promise<boolean> {
    await this.busy;
    if (!this.supported) return false;
    await this.snapshot("update");
    return this.last?.goal?.status === "active";
  }

  async pauseForStop() {
    if (this.timer) clearInterval(this.timer);
    // A persistence failure must not prevent attempting the actual Stop.
    await this.busy?.catch(() => {});
    try {
      const pending = this.options.readPending?.();
      if (pending && !this.seen.has(pending.id)) {
        this.seen.add(pending.id);
        await this.options.emit({
          type: "goal",
          phase: "command",
          ack: {
            id: pending.id,
            state: "cancelled",
          },
        });
      }
    } finally {
      // Read directly: failure to persist a display snapshot must not block
      // pausing the runtime before interrupting it.
      const response = await this.options.request(
        "thread/goal/get",
        {
          threadId: this.options.sessionId,
        },
        5000,
      );
      if (normalizeCodexGoal(response?.goal)?.status === "active") {
        await this.options.request(
          "thread/goal/set",
          {
            threadId: this.options.sessionId,
            status: "paused",
          },
          5000,
        );
        await this.snapshot("update");
      }
    }
  }

  private async snapshot(phase: CodexGoalEvent["phase"]) {
    const response = await this.options.request(
      "thread/goal/get",
      { threadId: this.options.sessionId },
      5000,
    );
    if (!response || !("goal" in response))
      throw Error("This Codex version does not support goal controls");
    const goal =
      response.goal === null ? null : normalizeCodexGoal(response.goal);
    if (goal === undefined) throw Error("Invalid Codex goal response");
    this.last = {
      sessionId: this.options.sessionId,
      observedAt: Date.now(),
      goal,
    };
    await this.options.emit({ type: "goal", phase, snapshot: this.last });
  }

  private tick(phase: "start" | "update" | "end"): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = this.run(phase).finally(() => {
      this.busy = undefined;
    });
    return this.busy;
  }

  private async run(phase: "start" | "update" | "end") {
    if (this.stopped) return;
    // A goal/set can launch an idle Codex turn. Never apply queued edits while
    // finalizing the current turn; leave them for the next requested turn.
    const command = phase === "end" ? undefined : this.options.readPending?.();
    const pending = command && !this.seen.has(command.id) ? command : undefined;
    if (pending) {
      // Do not repeatedly apply a command while its acknowledgement is syncing.
      this.seen.add(pending.id);
      try {
        validateCodexGoalCommand(pending);
        if (pending.sessionId && pending.sessionId !== this.options.sessionId)
          throw Error(
            "The Codex session changed. Review the goal and try again.",
          );
        if (!this.supported)
          throw Error(
            "This Codex version does not support goal controls. Upgrade Codex and try again.",
          );
        // Persist an applying marker before mutation. If the process dies in
        // the acknowledgement window, don't replay an old 'active' command
        // against a goal that may since have completed; require explicit retry.
        await this.options.emit({
          type: "goal",
          phase: "command",
          ack: { id: pending.id, state: "applying" },
        });
        if (pending.action === "clear") {
          const response = await this.options.request(
            "thread/goal/clear",
            { threadId: this.options.sessionId },
            5000,
          );
          if (typeof response?.cleared !== "boolean")
            throw Error("Invalid Codex clear-goal response");
        } else {
          const response = await this.options.request(
            "thread/goal/set",
            {
              threadId: this.options.sessionId,
              ...(pending.objective === undefined
                ? {}
                : { objective: pending.objective }),
              ...(pending.status === undefined
                ? {}
                : { status: pending.status }),
              ...(pending.tokenBudget === undefined
                ? {}
                : { tokenBudget: pending.tokenBudget }),
            },
            5000,
          );
          if (!normalizeCodexGoal(response?.goal))
            throw Error("Invalid Codex set-goal response");
        }
        await this.options.emit({
          type: "goal",
          phase: "command",
          ack: { id: pending.id, state: "applied" },
        });
        this.dirty = true;
      } catch (error) {
        await this.options.emit({
          type: "goal",
          phase: "command",
          ack: { id: pending.id, state: "failed", error: String(error) },
        });
      }
    }
    if (this.supported && (phase !== "update" || this.dirty)) {
      this.dirty = false;
      try {
        await this.snapshot(phase);
      } catch {
        // Unknown is not empty. Keep the last display snapshot intact.
        // Only a failed initial capability probe disables subsequent reads.
        if (phase === "start") this.supported = false;
      }
    }
  }

  async finish() {
    if (this.timer) clearInterval(this.timer);
    await this.busy;
    try {
      await this.tick("end");
    } finally {
      this.stopped = true;
    }
  }
}
