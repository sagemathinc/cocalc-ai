import { isValidUUID } from "@cocalc/util/misc";

export const ACP_SUBJECT_ROOT = process.env.COCALC_ACP_TEST
  ? "acp-test"
  : "acp";

export const ACP_OPERATIONS = [
  "api",
  "interrupt",
  "steer",
  "fork",
  "truncate",
  "control",
  "automation",
  "attention",
] as const;

export type AcpOperation = (typeof ACP_OPERATIONS)[number];

export type AcpSubjectIdentity = {
  account_id: string;
  project_id: string;
};

export type ParsedAcpSubject =
  | (AcpSubjectIdentity & {
      version: "account-project";
      operation: AcpOperation;
    })
  | {
      version: "legacy-project";
      project_id: string;
      operation: AcpOperation;
    };

export const ACP_CLIENT_REFRESH_REQUIRED_CODE = "ACP_CLIENT_REFRESH_REQUIRED";
export const ACP_CLIENT_REFRESH_REQUIRED_MESSAGE =
  "CoCalc's agent service was updated. Refresh this browser tab before starting another turn.";

const ACP_ROOTS = new Set(["acp", "acp-test"]);
const OPERATIONS = new Set<string>(ACP_OPERATIONS);

function isAcpOperation(value: string | undefined): value is AcpOperation {
  return value != null && OPERATIONS.has(value);
}

function requireIdentity({
  account_id,
  project_id,
}: AcpSubjectIdentity): AcpSubjectIdentity {
  if (!isValidUUID(project_id)) {
    throw new Error("project_id must be a valid uuid");
  }
  if (!isValidUUID(account_id)) {
    throw new Error("account_id must be a valid uuid");
  }
  return { account_id, project_id };
}

function buildAcpSubject(
  identity: AcpSubjectIdentity,
  operation: AcpOperation,
): string {
  const { account_id, project_id } = requireIdentity(identity);
  return `${ACP_SUBJECT_ROOT}.project-${project_id}.account-${account_id}.${operation}`;
}

export function isAcpSubject(subject: string): boolean {
  const root = subject.split(".", 1)[0];
  return ACP_ROOTS.has(root);
}

export function parseAcpSubject(subject: string): ParsedAcpSubject | undefined {
  const parts = subject.split(".");
  if (!ACP_ROOTS.has(parts[0])) {
    return;
  }
  const project_id = parts[1]?.startsWith("project-")
    ? parts[1].slice("project-".length)
    : "";
  if (!isValidUUID(project_id)) {
    return;
  }
  if (parts.length === 3 && isAcpOperation(parts[2])) {
    return {
      version: "legacy-project",
      project_id,
      operation: parts[2],
    };
  }
  const account_id = parts[2]?.startsWith("account-")
    ? parts[2].slice("account-".length)
    : "";
  if (
    parts.length !== 4 ||
    !isValidUUID(account_id) ||
    !isAcpOperation(parts[3])
  ) {
    return;
  }
  return {
    version: "account-project",
    account_id,
    project_id,
    operation: parts[3],
  };
}

export function acpSubscriptionSubject(operation: AcpOperation): string {
  return `${ACP_SUBJECT_ROOT}.*.*.${operation}`;
}

export function legacyAcpSubscriptionSubject(operation: AcpOperation): string {
  return `${ACP_SUBJECT_ROOT}.*.${operation}`;
}

export function acpSubject(identity: AcpSubjectIdentity): string {
  return buildAcpSubject(identity, "api");
}

export function acpInterruptSubject(identity: AcpSubjectIdentity): string {
  return buildAcpSubject(identity, "interrupt");
}

export function acpSteerSubject(identity: AcpSubjectIdentity): string {
  return buildAcpSubject(identity, "steer");
}

export function acpForkSubject(identity: AcpSubjectIdentity): string {
  return buildAcpSubject(identity, "fork");
}

export function acpTruncateSubject(identity: AcpSubjectIdentity): string {
  return buildAcpSubject(identity, "truncate");
}

export function acpControlSubject(identity: AcpSubjectIdentity): string {
  return buildAcpSubject(identity, "control");
}

export function acpAutomationSubject(identity: AcpSubjectIdentity): string {
  return buildAcpSubject(identity, "automation");
}

export function acpAttentionSubject(identity: AcpSubjectIdentity): string {
  return buildAcpSubject(identity, "attention");
}
