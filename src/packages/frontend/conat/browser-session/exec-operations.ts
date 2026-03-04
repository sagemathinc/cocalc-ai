import { isValidUUID } from "@cocalc/util/misc";
import type {
  BrowserAutomationPosture,
  BrowserExecOperation,
  BrowserExecPolicyV1,
} from "@cocalc/conat/service/browser-session";
import type { BrowserExecMode } from "./exec-utils";

export type BrowserExecPendingOperation = BrowserExecOperation & {
  code: string;
  posture: BrowserAutomationPosture;
  mode: BrowserExecMode;
  policy?: BrowserExecPolicyV1;
};

export function createBrowserExecOperations({
  maxExecOps,
  execOpTtlMs,
  maxExecCodeLength,
  createExecId,
  resolveExecMode,
  executeBrowserScript,
}: {
  maxExecOps: number;
  execOpTtlMs: number;
  maxExecCodeLength: number;
  createExecId: () => string;
  resolveExecMode: (args: {
    project_id: string;
    posture?: BrowserAutomationPosture;
    policy?: BrowserExecPolicyV1;
  }) => {
    posture: BrowserAutomationPosture;
    policy?: BrowserExecPolicyV1;
    mode: BrowserExecMode;
  };
  executeBrowserScript: (args: {
    project_id: string;
    code: string;
    mode: BrowserExecMode;
    policy?: BrowserExecPolicyV1;
    isCanceled?: () => boolean;
  }) => Promise<unknown>;
}): {
  startExec: (args: {
    project_id: string;
    code: string;
    posture?: BrowserAutomationPosture;
    policy?: BrowserExecPolicyV1;
  }) => { exec_id: string; status: BrowserExecOperation["status"] };
  getExec: (args: { exec_id: string }) => BrowserExecOperation;
  cancelExec: (args: {
    exec_id: string;
  }) => { ok: true; exec_id: string; status: BrowserExecOperation["status"] };
  clearExecs: () => void;
} {
  const execOps = new Map<string, BrowserExecPendingOperation>();

  const pruneExecOps = () => {
    const now = Date.now();
    for (const [exec_id, op] of execOps.entries()) {
      if (
        op.finished_at != null &&
        now - new Date(op.finished_at).getTime() > execOpTtlMs
      ) {
        execOps.delete(exec_id);
      }
    }
    if (execOps.size <= maxExecOps) return;
    const ordered = [...execOps.values()].sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    for (const op of ordered) {
      if (execOps.size <= maxExecOps) break;
      execOps.delete(op.exec_id);
    }
  };

  const getExecOp = (exec_id: string): BrowserExecPendingOperation => {
    const clean = `${exec_id ?? ""}`.trim();
    if (!clean) {
      throw Error("exec_id must be specified");
    }
    const op = execOps.get(clean);
    if (!op) {
      throw Error(`exec operation '${clean}' not found`);
    }
    return op;
  };

  const toPublicExecOp = (op: BrowserExecPendingOperation): BrowserExecOperation => {
    const {
      exec_id,
      project_id,
      status,
      created_at,
      started_at,
      finished_at,
      cancel_requested,
      error,
      result,
    } = op;
    return {
      exec_id,
      project_id,
      status,
      created_at,
      ...(started_at ? { started_at } : {}),
      ...(finished_at ? { finished_at } : {}),
      ...(cancel_requested ? { cancel_requested } : {}),
      ...(error ? { error } : {}),
      ...(result !== undefined ? { result } : {}),
    };
  };

  const runExecOperation = async (op: BrowserExecPendingOperation) => {
    if (op.status !== "pending") return;
    op.status = "running";
    op.started_at = new Date().toISOString();
    try {
      const result = await executeBrowserScript({
        project_id: op.project_id,
        code: op.code,
        mode: op.mode,
        policy: op.policy,
        isCanceled: () => !!op.cancel_requested,
      });
      if (op.cancel_requested) {
        op.status = "canceled";
        delete op.result;
      } else {
        op.status = "succeeded";
        op.result = result;
      }
      delete op.error;
    } catch (err) {
      if (op.cancel_requested) {
        op.status = "canceled";
        delete op.result;
        delete op.error;
      } else {
        op.status = "failed";
        op.error = `${err}`;
        delete op.result;
      }
    } finally {
      op.finished_at = new Date().toISOString();
      pruneExecOps();
    }
  };

  const startExec = ({
    project_id,
    code,
    posture,
    policy,
  }: {
    project_id: string;
    code: string;
    posture?: BrowserAutomationPosture;
    policy?: BrowserExecPolicyV1;
  }): { exec_id: string; status: BrowserExecOperation["status"] } => {
    const script = `${code ?? ""}`;
    if (!script.trim()) {
      throw Error("code must be specified");
    }
    if (script.length > maxExecCodeLength) {
      throw Error(
        `code is too long (${script.length} chars); max ${maxExecCodeLength}`,
      );
    }
    if (!isValidUUID(project_id)) {
      throw Error("project_id must be a UUID");
    }
    const enforced = resolveExecMode({ project_id, posture, policy });
    const exec_id = createExecId();
    const op: BrowserExecPendingOperation = {
      exec_id,
      project_id,
      status: "pending",
      created_at: new Date().toISOString(),
      code: script,
      posture: enforced.posture,
      mode: enforced.mode,
      ...(enforced.policy ? { policy: enforced.policy } : {}),
    };
    execOps.set(exec_id, op);
    pruneExecOps();
    void runExecOperation(op);
    return { exec_id, status: op.status };
  };

  const getExec = ({ exec_id }: { exec_id: string }): BrowserExecOperation => {
    pruneExecOps();
    return toPublicExecOp(getExecOp(exec_id));
  };

  const cancelExec = ({
    exec_id,
  }: {
    exec_id: string;
  }): { ok: true; exec_id: string; status: BrowserExecOperation["status"] } => {
    const op = getExecOp(exec_id);
    op.cancel_requested = true;
    if (op.status === "pending") {
      op.status = "canceled";
      op.finished_at = new Date().toISOString();
      delete op.result;
      delete op.error;
    }
    return { ok: true, exec_id: op.exec_id, status: op.status };
  };

  const clearExecs = (): void => {
    execOps.clear();
  };

  return { startExec, getExec, cancelExec, clearExecs };
}
