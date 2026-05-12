import { normalizeRawExecPolicy, resolveExecMode } from "./exec-utils";

const PROJECT_ID = "94ee01cf-2d7a-4e56-b8af-76d9a697877b";

describe("browser exec raw JavaScript policy", () => {
  it("normalizes invalid raw exec policy to disabled", () => {
    expect(normalizeRawExecPolicy("disabled")).toBe("disabled");
    expect(normalizeRawExecPolicy("admin_only")).toBe("admin_only");
    expect(normalizeRawExecPolicy("enabled")).toBe("enabled");
    expect(normalizeRawExecPolicy("")).toBe("disabled");
    expect(normalizeRawExecPolicy("bogus")).toBe("disabled");
  });

  it("forces QuickJS when raw exec is disabled", () => {
    expect(
      resolveExecMode({
        project_id: PROJECT_ID,
        posture: "dev",
        rawExecPolicy: "disabled",
        isAdmin: true,
      }).mode,
    ).toBe("quickjs_wasm");

    expect(
      resolveExecMode({
        project_id: PROJECT_ID,
        posture: "prod",
        policy: { version: 1, allow_raw_exec: true },
        rawExecPolicy: "disabled",
        isAdmin: true,
      }).mode,
    ).toBe("quickjs_wasm");
  });

  it("allows raw exec for admins under admin_only when caller requests raw", () => {
    expect(
      resolveExecMode({
        project_id: PROJECT_ID,
        posture: "dev",
        rawExecPolicy: "admin_only",
        isAdmin: true,
      }).mode,
    ).toBe("raw_js");

    expect(
      resolveExecMode({
        project_id: PROJECT_ID,
        posture: "prod",
        policy: { version: 1, allow_raw_exec: true },
        rawExecPolicy: "admin_only",
        isAdmin: true,
      }).mode,
    ).toBe("raw_js");
  });

  it("forces QuickJS for non-admins under admin_only", () => {
    expect(
      resolveExecMode({
        project_id: PROJECT_ID,
        posture: "dev",
        rawExecPolicy: "admin_only",
        isAdmin: false,
      }).mode,
    ).toBe("quickjs_wasm");

    expect(
      resolveExecMode({
        project_id: PROJECT_ID,
        posture: "prod",
        policy: { version: 1, allow_raw_exec: true },
        rawExecPolicy: "admin_only",
        isAdmin: false,
      }).mode,
    ).toBe("quickjs_wasm");
  });

  it("honors caller posture and policy when raw exec is enabled", () => {
    expect(
      resolveExecMode({
        project_id: PROJECT_ID,
        posture: "dev",
        rawExecPolicy: "enabled",
      }).mode,
    ).toBe("raw_js");

    expect(
      resolveExecMode({
        project_id: PROJECT_ID,
        posture: "prod",
        rawExecPolicy: "enabled",
      }).mode,
    ).toBe("quickjs_wasm");

    expect(
      resolveExecMode({
        project_id: PROJECT_ID,
        posture: "prod",
        policy: { version: 1, allow_raw_exec: true },
        rawExecPolicy: "enabled",
      }).mode,
    ).toBe("raw_js");
  });
});
