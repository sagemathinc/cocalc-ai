import {
  assertLegacyRusticOperationAllowed,
  managedRusticSupervisionEnabled,
} from "./managed-rustic";

describe("managed Rustic rollout admission", () => {
  const original = process.env.COCALC_MANAGED_RUSTIC_SUPERVISION;
  afterEach(() => {
    if (original == null) delete process.env.COCALC_MANAGED_RUSTIC_SUPERVISION;
    else process.env.COCALC_MANAGED_RUSTIC_SUPERVISION = original;
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
