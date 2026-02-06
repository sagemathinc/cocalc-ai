import { AgentCapabilityRegistry } from "../capabilities";
import { registerBasicCapabilities } from "../packs";
import { buildCapabilityManifest } from "../manifest";
import type { AgentSdkContext } from "../adapters";

describe("buildCapabilityManifest", () => {
  test("projects stable action metadata from registry", () => {
    const registry = new AgentCapabilityRegistry<AgentSdkContext>();
    registerBasicCapabilities(registry);

    const manifest = buildCapabilityManifest(registry);
    expect(manifest.length).toBe(8);
    expect(manifest[0].actionType).toBe("hub.projects.create");
    expect(
      manifest.find((x) => x.actionType === "project.system.write_text_file"),
    ).toEqual(
      expect.objectContaining({
        actionType: "project.system.write_text_file",
        riskLevel: "write",
        sideEffectScope: "project",
        supportsDryRun: true,
      }),
    );
  });

  test("accepts raw descriptor arrays", () => {
    const manifest = buildCapabilityManifest([
      {
        actionType: "z.action",
        summary: "z",
        handler: async () => ({}),
      },
      {
        actionType: "a.action",
        summary: "a",
        riskLevel: "read",
        sideEffectScope: "ui",
        supportsDryRun: false,
        handler: async () => ({}),
      },
    ]);
    expect(manifest.map((x) => x.actionType)).toEqual([
      "a.action",
      "z.action",
    ]);
    expect(manifest[0]).toEqual(
      expect.objectContaining({
        actionType: "a.action",
        riskLevel: "read",
        sideEffectScope: "ui",
        supportsDryRun: false,
      }),
    );
  });
});

