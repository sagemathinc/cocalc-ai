import { evaluateBayDrainPreflight, evaluateBayDrainTable } from "./preflight";

describe("bay drain preflight", () => {
  it("blocks unknown tables even with unsafe rehome", () => {
    const finding = evaluateBayDrainTable({
      table: "mystery_customer_state",
      source_bay_id: "bay-a",
      seed_bay_id: "seed",
      unsafe_rehome: true,
    });

    expect(finding.severity).toBe("block");
  });

  it("blocks unsupported owned tables without unsafe rehome", () => {
    const finding = evaluateBayDrainTable({
      table: "purchases",
      source_bay_id: "bay-a",
      seed_bay_id: "seed",
    });

    expect(finding.severity).toBe("block");
    expect(finding.reason).toMatch(/unsupported/);
  });

  it("downgrades unsupported owned tables to warnings with unsafe rehome", () => {
    const finding = evaluateBayDrainTable({
      table: "purchases",
      source_bay_id: "bay-a",
      seed_bay_id: "seed",
      unsafe_rehome: true,
    });

    expect(finding.severity).toBe("warn");
  });

  it("blocks billing ledger tables during normal drain", () => {
    const result = evaluateBayDrainPreflight({
      source_bay_id: "bay-a",
      seed_bay_id: "seed",
      tables: ["purchases", "statements"],
    });

    expect(result.ok).toBe(false);
    expect(result.findings.map((item) => item.severity)).toEqual([
      "block",
      "block",
    ]);
    expect(result.findings.map((item) => item.ownership)).toEqual([
      "account-home",
      "account-home",
    ]);
  });

  it("blocks self-host connector state during normal drain", () => {
    const result = evaluateBayDrainPreflight({
      source_bay_id: "bay-a",
      seed_bay_id: "seed",
      tables: [
        "self_host_connectors",
        "self_host_connector_tokens",
        "self_host_commands",
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.findings.map((item) => item.severity)).toEqual([
      "block",
      "block",
      "block",
    ]);
  });

  it("allows cache and projection tables", () => {
    const result = evaluateBayDrainPreflight({
      source_bay_id: "bay-a",
      seed_bay_id: "seed",
      tables: ["account_project_index", "cloud_pricing_cache"],
    });

    expect(result.ok).toBe(true);
    expect(result.findings.map((item) => item.severity)).toEqual(["ok", "ok"]);
  });

  it("warns about seed-global tables on non-seed bays", () => {
    const finding = evaluateBayDrainTable({
      table: "membership_tiers",
      source_bay_id: "bay-a",
      seed_bay_id: "seed",
    });

    expect(finding.severity).toBe("warn");
  });
});
