import {
  assertLegacyRusticOperationAllowed,
  managedRusticSupervisionEnabled,
  managedRusticEvidenceEnabled,
} from "./managed-rustic";

describe("managed Rustic rollout admission", () => {
  const original = process.env.COCALC_MANAGED_RUSTIC_SUPERVISION;
  const originalEvidence = process.env.COCALC_MANAGED_RUSTIC_EVIDENCE;
  afterEach(() => {
    if (original == null) delete process.env.COCALC_MANAGED_RUSTIC_SUPERVISION;
    else process.env.COCALC_MANAGED_RUSTIC_SUPERVISION = original;
    if (originalEvidence == null)
      delete process.env.COCALC_MANAGED_RUSTIC_EVIDENCE;
    else process.env.COCALC_MANAGED_RUSTIC_EVIDENCE = originalEvidence;
  });

  it("requires both caller gates and rejects ambiguous evidence configuration", () => {
    delete process.env.COCALC_MANAGED_RUSTIC_EVIDENCE;
    expect(managedRusticEvidenceEnabled()).toBe(false);
    process.env.COCALC_MANAGED_RUSTIC_EVIDENCE = "1";
    delete process.env.COCALC_MANAGED_RUSTIC_SUPERVISION;
    expect(managedRusticEvidenceEnabled).toThrow("requires supervision");
    process.env.COCALC_MANAGED_RUSTIC_SUPERVISION = "1";
    expect(managedRusticEvidenceEnabled()).toBe(true);
    process.env.COCALC_MANAGED_RUSTIC_EVIDENCE = "yes";
    expect(managedRusticEvidenceEnabled).toThrow("must be 0 or 1");
  });

  it.each([undefined, "0"])(
    "preserves legacy behavior with gate %s",
    (value) => {
      if (value == null) delete process.env.COCALC_MANAGED_RUSTIC_SUPERVISION;
      else process.env.COCALC_MANAGED_RUSTIC_SUPERVISION = value;
      expect(managedRusticSupervisionEnabled()).toBe(false);
      expect(() => assertLegacyRusticOperationAllowed("backup")).not.toThrow();
      expect(() => assertLegacyRusticOperationAllowed("restore")).not.toThrow();
    },
  );

  it("blocks backup/restore fallbacks, not browsing commands", () => {
    process.env.COCALC_MANAGED_RUSTIC_SUPERVISION = "1";
    expect(managedRusticSupervisionEnabled()).toBe(true);
    for (const command of ["backup", "restore"]) {
      expect(() => assertLegacyRusticOperationAllowed(command)).toThrow(
        "unsupervised fallback is disabled",
      );
    }
    for (const command of ["snapshots", "ls", "find"]) {
      expect(() => assertLegacyRusticOperationAllowed(command)).not.toThrow();
    }
  });

  it.each(["", "true", "yes", "2"])("rejects ambiguous gate %s", (value) => {
    process.env.COCALC_MANAGED_RUSTIC_SUPERVISION = value;
    expect(() => assertLegacyRusticOperationAllowed("restore")).toThrow(
      "must be 0 or 1",
    );
  });
});
