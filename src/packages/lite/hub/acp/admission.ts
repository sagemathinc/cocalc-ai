import type { AcpJobRequest } from "@cocalc/conat/ai/acp/types";
import type { MembershipEffectiveLimits } from "@cocalc/conat/hub/api/purchases";
import {
  countCreatedAcpJobsForAccountSince,
  countQueuedAcpJobsForAccount,
  countQueuedAcpJobsForThread,
  countRunningAcpJobsForAccount,
  countRunningAcpJobsForProject,
  type AcpJobRow,
} from "../sqlite/acp-jobs";

const FIVE_HOURS_MS = 5 * 60 * 60_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000;

function envLimit(name: string, fallback: number): number {
  const raw = `${process.env[name] ?? ""}`.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

export type AcpAdmissionLimitName =
  | "queued_per_account"
  | "queued_per_thread"
  | "created_5h_per_account"
  | "created_7d_per_account"
  | "running_per_account"
  | "running_per_project";

export type AcpAdmissionLimits = {
  queuedPerAccount: number;
  queuedPerThread: number;
  created5hPerAccount: number;
  created7dPerAccount: number;
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
  | "automation"
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
};

export class AcpAdmissionDeniedError extends Error {
  readonly denial: AcpAdmissionDenial;

  constructor(denial: AcpAdmissionDenial) {
    super(formatAcpAdmissionDenial(denial));
    this.name = "AcpAdmissionDeniedError";
    this.denial = denial;
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

export function isAcpAdmissionDeniedError(
  err: unknown,
): err is AcpAdmissionDeniedError {
  return err instanceof AcpAdmissionDeniedError;
}

export function getDefaultAcpAdmissionLimits(): AcpAdmissionLimits {
  return {
    queuedPerAccount: envLimit("COCALC_ACP_MAX_QUEUED_PER_ACCOUNT", 1000),
    queuedPerThread: envLimit("COCALC_ACP_MAX_QUEUED_PER_THREAD", 100),
    created5hPerAccount: envLimit("COCALC_ACP_MAX_CREATED_5H_PER_ACCOUNT", 500),
    created7dPerAccount: envLimit(
      "COCALC_ACP_MAX_CREATED_7D_PER_ACCOUNT",
      2000,
    ),
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
    created5hPerAccount:
      normalizedLimit(overrides.created5hPerAccount) ??
      base.created5hPerAccount,
    created7dPerAccount:
      normalizedLimit(overrides.created7dPerAccount) ??
      base.created7dPerAccount,
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
  const created5hPerAccount = normalizedLimit(
    effectiveLimits.acp_max_created_5h_per_account,
  );
  if (created5hPerAccount != null) {
    limits.created5hPerAccount = created5hPerAccount;
  }
  const created7dPerAccount = normalizedLimit(
    effectiveLimits.acp_max_created_7d_per_account,
  );
  if (created7dPerAccount != null) {
    limits.created7dPerAccount = created7dPerAccount;
  }
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

function recoveryParentId(request: AcpJobRequest): string {
  return `${request.recovery_parent_op_id ?? request.chat?.recovery_parent_op_id ?? ""}`.trim();
}

export function admitAcpJobCreation(
  request: AcpJobRequest,
  limits: AcpAdmissionLimits = getDefaultAcpAdmissionLimits(),
  now = Date.now(),
): AcpAdmissionDecision {
  return admitAcpJobCreationIdentity(
    {
      account_id: request.account_id,
      project_id: request.chat?.project_id ?? request.project_id,
      path: request.chat?.path,
      thread_id: request.chat?.thread_id,
      recovery_parent_op_id: recoveryParentId(request),
    },
    limits,
    now,
  );
}

export function admitAcpJobCreationIdentity(
  identity: AcpCreationAdmissionIdentity,
  limits: AcpAdmissionLimits = getDefaultAcpAdmissionLimits(),
  now = Date.now(),
): AcpAdmissionDecision {
  if (`${identity.recovery_parent_op_id ?? ""}`.trim()) {
    return { ok: true };
  }
  const account_id = `${identity.account_id ?? ""}`.trim();
  const project_id = `${identity.project_id ?? ""}`.trim();
  const path = `${identity.path ?? ""}`.trim();
  const thread_id = `${identity.thread_id ?? ""}`.trim();

  const queuedPerAccount = finiteLimit(limits.queuedPerAccount);
  if (account_id && queuedPerAccount != null) {
    const current = countQueuedAcpJobsForAccount(account_id);
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

  const created5h = finiteLimit(limits.created5hPerAccount);
  if (account_id && created5h != null) {
    const current = countCreatedAcpJobsForAccountSince({
      account_id,
      since: now - FIVE_HOURS_MS,
    });
    if (current >= created5h) {
      return denied({
        ok: false,
        limit: "created_5h_per_account",
        current,
        maximum: created5h,
        account_id,
        project_id,
      });
    }
  }

  const created7d = finiteLimit(limits.created7dPerAccount);
  if (account_id && created7d != null) {
    const current = countCreatedAcpJobsForAccountSince({
      account_id,
      since: now - SEVEN_DAYS_MS,
    });
    if (current >= created7d) {
      return denied({
        ok: false,
        limit: "created_7d_per_account",
        current,
        maximum: created7d,
        account_id,
        project_id,
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

export function formatAcpAdmissionDenial(denial: AcpAdmissionDenial): string {
  return `ACP turn limit reached: ${denial.limit} is ${denial.current}/${denial.maximum}`;
}
