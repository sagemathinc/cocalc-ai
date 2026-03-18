import { buildMoveSmokeHostNames, withSmokeHostRoleSuffix } from "./host-names";

describe("smoke-runner host names", () => {
  it("preserves distinct source and destination suffixes under truncation", () => {
    const base =
      "smoke-gcp-e2s2-1773845723467-2026-03-18t14-55-22-236z-gcp-move";
    const { sourceHostName, destHostName } = buildMoveSmokeHostNames(base);

    expect(sourceHostName).toHaveLength(63);
    expect(destHostName).toHaveLength(63);
    expect(sourceHostName.endsWith("-src")).toBe(true);
    expect(destHostName.endsWith("-dst")).toBe(true);
    expect(sourceHostName).not.toBe(destHostName);
  });

  it("sanitizes host names while keeping the role suffix", () => {
    const name = withSmokeHostRoleSuffix("  weird host/name!!  ", "dst");
    expect(name).toBe("weird-host-name-dst");
  });
});
