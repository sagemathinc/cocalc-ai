import {
  ACP_CLIENT_REFRESH_REQUIRED_CODE,
  ACP_OPERATIONS,
  ACP_SUBJECT_ROOT,
  acpControlSubject,
  acpForkSubject,
  acpInterruptSubject,
  acpSteerSubject,
  acpSubject,
  acpSubscriptionSubject,
  acpTruncateSubject,
  isAcpSubject,
  legacyAcpSubscriptionSubject,
  parseAcpSubject,
} from "./subjects";

describe("account-and-project-bound ACP subjects", () => {
  const project_id = "00000000-0000-4000-8000-000000000001";
  const account_id = "00000000-0000-4000-8000-000000000002";
  const identity = { account_id, project_id };

  it.each([
    ["api", acpSubject],
    ["interrupt", acpInterruptSubject],
    ["steer", acpSteerSubject],
    ["fork", acpForkSubject],
    ["truncate", acpTruncateSubject],
    ["control", acpControlSubject],
  ] as const)("builds and parses the %s subject", (operation, build) => {
    const subject = build(identity);
    expect(subject).toBe(
      `${ACP_SUBJECT_ROOT}.project-${project_id}.account-${account_id}.${operation}`,
    );
    expect(parseAcpSubject(subject)).toEqual({
      version: "account-project",
      account_id,
      project_id,
      operation,
    });
  });

  it.each(ACP_OPERATIONS)("parses legacy %s subjects", (operation) => {
    expect(
      parseAcpSubject(`${ACP_SUBJECT_ROOT}.project-${project_id}.${operation}`),
    ).toEqual({
      version: "legacy-project",
      project_id,
      operation,
    });
  });

  it("builds distinct current and legacy subscription patterns", () => {
    expect(acpSubscriptionSubject("api")).toBe(`${ACP_SUBJECT_ROOT}.*.*.api`);
    expect(legacyAcpSubscriptionSubject("api")).toBe(
      `${ACP_SUBJECT_ROOT}.*.api`,
    );
  });

  it.each([
    `${ACP_SUBJECT_ROOT}.project-${project_id}.account-not-a-uuid.api`,
    `${ACP_SUBJECT_ROOT}.project-not-a-uuid.account-${account_id}.api`,
    `${ACP_SUBJECT_ROOT}.project-${project_id}.account-${account_id}.unknown`,
    `${ACP_SUBJECT_ROOT}.project-${project_id}.account-${account_id}.api.extra`,
    `${ACP_SUBJECT_ROOT}.account-${account_id}.api`,
    `${ACP_SUBJECT_ROOT}.hub.api`,
  ])("rejects malformed ACP subject %s", (subject) => {
    expect(isAcpSubject(subject)).toBe(true);
    expect(parseAcpSubject(subject)).toBeUndefined();
  });

  it("requires valid identities when building subjects", () => {
    expect(() => acpSubject({ account_id: "invalid", project_id })).toThrow(
      "account_id must be a valid uuid",
    );
    expect(() => acpSubject({ account_id, project_id: "invalid" })).toThrow(
      "project_id must be a valid uuid",
    );
  });

  it("uses a stable machine-readable refresh code", () => {
    expect(ACP_CLIENT_REFRESH_REQUIRED_CODE).toBe(
      "ACP_CLIENT_REFRESH_REQUIRED",
    );
  });
});
