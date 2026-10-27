import type { AcpJobRequest, AcpRequest } from "@cocalc/conat/ai/acp/types";
import type { MembershipEffectiveLimits } from "@cocalc/conat/hub/api/purchases";
import {
  countQueuedAcpJobsForAccount,
  countQueuedAcpJobsForThread,
  countRunningAcpJobsForAccount,
  countRunningAcpJobsForProject,
  type AcpJobRow,
} from "../sqlite/acp-jobs";

function envLimit(name: string, fallback: number): number {
  const raw = `${process.env[name] ?? ""}`.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

// There is no limit on how many turns are created over time: the queued and
// running (concurrency) limits throttle usage enough. (The rolling 5-hour and
// 7-day created-turn limits were removed.)
export type AcpAdmissionLimitName =
  | "queued_per_account"
  | "queued_per_thread"
  | "running_per_account"
  | "running_per_project";

export type AcpAdmissionLimits = {
  queuedPerAccount: number;
  queuedPerThread: number;
  runningPerAccount: number;
  runningPerProject: number;
};

export type AcpAdmissionLimitContext = {
  account_id?: string;
  project_id?: string;
  path?: string;
  thread_id?: string;
};

export type AcpAdmissionLimitsProvider = (
  context: AcpAdmissionLimitContext,
) =>
  | Partial<AcpAdmissionLimits>
  | undefined
  | Promise<Partial<AcpAdmissionLimits> | undefined>;

export type AcpAdmissionDenial = {
  ok: false;
  limit: AcpAdmissionLimitName;
  current: number;
  maximum: number;
  account_id?: string;
  project_id?: string;
  path?: string;
  thread_id?: string;
};

export type AcpAdmissionDecision = { ok: true } | AcpAdmissionDenial;

export type AcpAdmissionDenialSource =
  | "chat"
  | "claim"
  | "recovery"
  | "resend"
  | "unknown";

export type AcpAdmissionDenialEvent = AcpAdmissionDenial & {
  source: AcpAdmissionDenialSource;
  time: number;
};

export type AcpAdmissionDenialRecorder = (
  event: AcpAdmissionDenialEvent,
) => void | Promise<void>;

type AcpCreationAdmissionIdentity = {
  account_id?: string;
  project_id?: string;
  path?: string;
  thread_id?: string;
  recovery_parent_op_id?: string;
  supersedes_queued_recoveries?: boolean;
};

export class AcpAdmissionDeniedError extends Error {
  readonly denial: AcpAdmissionDenial;

  constructor(denial: AcpAdmissionDenial) {
    super(formatAcpAdmissionDenial(denial));
    this.name = "AcpAdmissionDeniedError";
    this.denial = denial;
  }

  // People see this error as text: the message alone, without the class name.
  toString(): string {
    return this.message;
  }
}

let acpAdmissionLimitsProvider: AcpAdmissionLimitsProvider | undefined;
let acpAdmissionDenialRecorder: AcpAdmissionDenialRecorder | undefined;

export function setAcpAdmissionLimitsProvider(
  provider?: AcpAdmissionLimitsProvider,
): void {
  acpAdmissionLimitsProvider = provider;
}

export function setAcpAdmissionDenialRecorder(
  recorder?: AcpAdmissionDenialRecorder,
): void {
  acpAdmissionDenialRecorder = recorder;
}

export function getDefaultAcpAdmissionLimits(): AcpAdmissionLimits {
  return {
    queuedPerAccount: envLimit("COCALC_ACP_MAX_QUEUED_PER_ACCOUNT", 1000),
    queuedPerThread: envLimit("COCALC_ACP_MAX_QUEUED_PER_THREAD", 100),
    runningPerAccount: envLimit("COCALC_ACP_MAX_RUNNING_PER_ACCOUNT", 50),
    runningPerProject: envLimit("COCALC_ACP_MAX_RUNNING_PER_PROJECT", 50),
  };
}

function normalizedLimit(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.floor(number)
    : undefined;
}

export function mergeAcpAdmissionLimits(
  base: AcpAdmissionLimits,
  overrides?: Partial<AcpAdmissionLimits>,
): AcpAdmissionLimits {
  if (overrides == null) return base;
  return {
    queuedPerAccount:
      normalizedLimit(overrides.queuedPerAccount) ?? base.queuedPerAccount,
    queuedPerThread:
      normalizedLimit(overrides.queuedPerThread) ?? base.queuedPerThread,
    runningPerAccount:
      normalizedLimit(overrides.runningPerAccount) ?? base.runningPerAccount,
    runningPerProject:
      normalizedLimit(overrides.runningPerProject) ?? base.runningPerProject,
  };
}

export function acpAdmissionLimitsFromEffectiveLimits(
  effectiveLimits?: MembershipEffectiveLimits | null,
): Partial<AcpAdmissionLimits> | undefined {
  if (effectiveLimits == null) return undefined;
  const limits: Partial<AcpAdmissionLimits> = {};
  const queuedPerAccount = normalizedLimit(
    effectiveLimits.acp_max_queued_per_account,
  );
  if (queuedPerAccount != null) limits.queuedPerAccount = queuedPerAccount;
  const queuedPerThread = normalizedLimit(
    effectiveLimits.acp_max_queued_per_thread,
  );
  if (queuedPerThread != null) limits.queuedPerThread = queuedPerThread;
  const runningPerAccount = normalizedLimit(
    effectiveLimits.acp_max_running_per_account,
  );
  if (runningPerAccount != null) limits.runningPerAccount = runningPerAccount;
  const runningPerProject = normalizedLimit(
    effectiveLimits.acp_max_running_per_project,
  );
  if (runningPerProject != null) limits.runningPerProject = runningPerProject;
  return limits;
}

export async function resolveAcpAdmissionLimits(
  context: AcpAdmissionLimitContext = {},
): Promise<AcpAdmissionLimits> {
  const defaults = getDefaultAcpAdmissionLimits();
  if (acpAdmissionLimitsProvider == null) return defaults;
  try {
    return mergeAcpAdmissionLimits(
      defaults,
      await acpAdmissionLimitsProvider(context),
    );
  } catch {
    return defaults;
  }
}

function finiteLimit(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function denied({
  limit,
  current,
  maximum,
  account_id,
  project_id,
  path,
  thread_id,
}: AcpAdmissionDenial): AcpAdmissionDenial {
  return {
    ok: false,
    limit,
    current,
    maximum,
    account_id,
    project_id,
    path,
    thread_id,
  };
}

/**
 * Only the worker assigns recovery lineage, when it resumes an interrupted
 * turn; a turn submitted by a client never continues another one.
 */
export function withoutRecoveryLineage<T extends AcpRequest>(request: T): T {
  const {
    recovery_parent_op_id: _parent,
    recovery_reason: _reason,
    recovery_count: _count,
    ...rest
  } = request;
  if (rest.chat == null) return rest as T;
  const {
    recovery_parent_op_id: _chatParent,
    recovery_reason: _chatReason,
    recovery_count: _chatCount,
    ...chat
  } = rest.chat;
  return { ...rest, chat } as T;
}

function recoveryParentId(request: AcpJobRequest): string {
  return `${request.recovery_parent_op_id ?? request.chat?.recovery_parent_op_id ?? ""}`.trim();
}

export function admitAcpJobCreation(
  request: AcpJobRequest,
  limits: AcpAdmissionLimits = getDefaultAcpAdmissionLimits(),
  opts: { supersedesQueuedRecoveries?: boolean } = {},
): AcpAdmissionDecision {
  return admitAcpJobCreationIdentity(
    {
      account_id: request.account_id,
      project_id: request.chat?.project_id ?? request.project_id,
      path: request.chat?.path,
      thread_id: request.chat?.thread_id,
      recovery_parent_op_id: recoveryParentId(request),
      supersedes_queued_recoveries: opts.supersedesQueuedRecoveries === true,
    },
    limits,
  );
}

function admitAcpJobCreationIdentity(
  identity: AcpCreationAdmissionIdentity,
  limits: AcpAdmissionLimits = getDefaultAcpAdmissionLimits(),
): AcpAdmissionDecision {
  if (`${identity.recovery_parent_op_id ?? ""}`.trim()) {
    return { ok: true };
  }
  const account_id = `${identity.account_id ?? ""}`.trim();
  const project_id = `${identity.project_id ?? ""}`.trim();
  const path = `${identity.path ?? ""}`.trim();
  const thread_id = `${identity.thread_id ?? ""}`.trim();
  const supersededRecoveryThread =
    identity.supersedes_queued_recoveries &&
    project_id.length > 0 &&
    path.length > 0 &&
    thread_id.length > 0
      ? { project_id, path, thread_id }
      : undefined;

  const queuedPerAccount = finiteLimit(limits.queuedPerAccount);
  if (account_id && queuedPerAccount != null) {
    const current = countQueuedAcpJobsForAccount(
      account_id,
      supersededRecoveryThread,
    );
    if (current >= queuedPerAccount) {
      return denied({
        ok: false,
        limit: "queued_per_account",
        current,
        maximum: queuedPerAccount,
        account_id,
        project_id,
      });
    }
  }

  const queuedPerThread = finiteLimit(limits.queuedPerThread);
  if (project_id && path && thread_id && queuedPerThread != null) {
    const current = countQueuedAcpJobsForThread({
      project_id,
      path,
      thread_id,
      includeRecovery: supersededRecoveryThread == null,
    });
    if (current >= queuedPerThread) {
      return denied({
        ok: false,
        limit: "queued_per_thread",
        current,
        maximum: queuedPerThread,
        account_id,
        project_id,
        path,
        thread_id,
      });
    }
  }

  return { ok: true };
}

export function admitAcpJobExecution(
  job: AcpJobRow,
  limits: AcpAdmissionLimits = getDefaultAcpAdmissionLimits(),
): AcpAdmissionDecision {
  const project_id = `${job.project_id ?? ""}`.trim();
  const account_id = `${job.account_id ?? ""}`.trim();

  const runningPerProject = finiteLimit(limits.runningPerProject);
  if (project_id && runningPerProject != null) {
    const current = countRunningAcpJobsForProject(project_id);
    if (current >= runningPerProject) {
      return denied({
        ok: false,
        limit: "running_per_project",
        current,
        maximum: runningPerProject,
        account_id,
        project_id,
        path: job.path,
        thread_id: job.thread_id,
      });
    }
  }

  const runningPerAccount = finiteLimit(limits.runningPerAccount);
  if (account_id && runningPerAccount != null) {
    const current = countRunningAcpJobsForAccount(account_id);
    if (current >= runningPerAccount) {
      return denied({
        ok: false,
        limit: "running_per_account",
        current,
        maximum: runningPerAccount,
        account_id,
        project_id,
        path: job.path,
        thread_id: job.thread_id,
      });
    }
  }

  return { ok: true };
}

export function throwIfAcpAdmissionDenied(
  decision: AcpAdmissionDecision,
  source: AcpAdmissionDenialSource = "unknown",
): void {
  if (!decision.ok) {
    recordAcpAdmissionDenial(decision, source);
    throw new AcpAdmissionDeniedError(decision);
  }
}

export function recordAcpAdmissionDenial(
  denial: AcpAdmissionDenial,
  source: AcpAdmissionDenialSource = "unknown",
): void {
  if (acpAdmissionDenialRecorder == null) return;
  const event: AcpAdmissionDenialEvent = {
    ...denial,
    source,
    time: Date.now(),
  };
  void Promise.resolve(acpAdmissionDenialRecorder(event)).catch(() => {
    // Admission telemetry must never make enqueue/claim admission less robust.
  });
}

// What each limit counts and the setting that controls it, as an admin finds
// it: the membership tier field (Admin > Membership tiers > Codex / ACP) or
// the same key as an account entitlement override.
const ADMISSION_LIMIT_TEXT: Record<
  AcpAdmissionLimitName,
  { counted: string; setting: string; key: string; env: string }
> = {
  queued_per_account: {
    counted: "waiting to run for this account",
    setting: "Queued ACP turns / account",
    key: "acp_max_queued_per_account",
    env: "COCALC_ACP_MAX_QUEUED_PER_ACCOUNT",
  },
  queued_per_thread: {
    counted: "waiting to run in this chat thread",
    setting: "Queued ACP turns / thread",
    key: "acp_max_queued_per_thread",
    env: "COCALC_ACP_MAX_QUEUED_PER_THREAD",
  },
  running_per_account: {
    counted: "running at once for this account",
    setting: "Running ACP turns / account",
    key: "acp_max_running_per_account",
    env: "COCALC_ACP_MAX_RUNNING_PER_ACCOUNT",
  },
  running_per_project: {
    counted: "running at once in this project",
    setting: "Running ACP turns / project",
    key: "acp_max_running_per_project",
    env: "COCALC_ACP_MAX_RUNNING_PER_PROJECT",
  },
};

export function formatAcpAdmissionDenial(denial: AcpAdmissionDenial): string {
  const text = ADMISSION_LIMIT_TEXT[denial.limit];
  if (text == null) {
    return `Agent turn limit reached (${denial.limit}): ${denial.current} of ${denial.maximum}.`;
  }
  const where =
    `"${text.setting}" (usage_limits.${text.key}) ` +
    `in the account's membership tier, or as an entitlement override for this account; ` +
    `without either, the server default ${text.env} applies.`;
  if (denial.maximum <= 0) {
    // Waiting cannot help: nothing is allowed at all. An account whose email
    // address is not verified yet gets 0 for every limit, so say that first.
    return (
      `Agent turns are not allowed here: the limit on agent turns ${text.counted} is 0. ` +
      `If this account's email address is not verified yet, verify it; ` +
      `otherwise ask an admin to raise ${where}`
    );
  }
  const turns = denial.current == 1 ? "agent turn" : "agent turns";
  return (
    `Agent turn limit reached: ${denial.current} ${turns} ${text.counted}, and the limit is ${denial.maximum}. ` +
    `Wait for some of them to finish. An admin can change the limit with ${where}`
  );
}
