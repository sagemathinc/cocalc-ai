import { parseDefaultGcpLabels, withDefaultGcpLabels } from "../gcp-labels";

describe("parseDefaultGcpLabels", () => {
  it("returns no labels when unset or empty", () => {
    expect(parseDefaultGcpLabels(undefined)).toEqual({});
    expect(parseDefaultGcpLabels("")).toEqual({});
    expect(parseDefaultGcpLabels(" , ")).toEqual({});
  });

  it("parses comma-separated key=value pairs", () => {
    expect(
      parseDefaultGcpLabels(
        " environment=production, owner=ops ,project=cocalc,dataclassification=confidential",
      ),
    ).toEqual({
      environment: "production",
      owner: "ops",
      project: "cocalc",
      dataclassification: "confidential",
    });
  });

  it("allows an empty value, as GCP does", () => {
    expect(parseDefaultGcpLabels("reviewed=")).toEqual({ reviewed: "" });
    expect(parseDefaultGcpLabels("reviewed")).toEqual({ reviewed: "" });
  });

  it("skips entries GCP would reject instead of failing the whole insert", () => {
    expect(
      parseDefaultGcpLabels(
        "Environment=prod,owner=Bad Value,9key=x,ok=yes," +
          `long=${"a".repeat(64)}`,
      ),
    ).toEqual({ ok: "yes" });
  });
});

describe("withDefaultGcpLabels", () => {
  const defaults = { environment: "production", owner: "ops" };

  it("returns undefined when there are no labels at all", () => {
    expect(withDefaultGcpLabels(undefined, {})).toBeUndefined();
  });

  it("adds defaults to explicit labels", () => {
    expect(
      withDefaultGcpLabels({ application: "project-host" }, defaults),
    ).toEqual({
      environment: "production",
      owner: "ops",
      application: "project-host",
    });
  });

  it("never overrides an explicit label (e.g. a dedicated VM's owner)", () => {
    expect(
      withDefaultGcpLabels({ owner: "14a0013f5cb545a0" }, defaults),
    ).toEqual({ environment: "production", owner: "14a0013f5cb545a0" });
  });

  it("rejects more than 64 labels", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 65; i++) many[`k${i}`] = "v";
    expect(() => withDefaultGcpLabels(many, {})).toThrow(/too many/);
  });
});
