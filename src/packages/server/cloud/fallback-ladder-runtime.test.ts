import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { injectedStartFault } from "./fallback-ladder-runtime";

describe("injected spot recovery faults (staging only)", () => {
  let dir: string;
  const previous = process.env.COCALC_SPOT_RECOVERY_FAULTS_FILE;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spot-faults-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) {
      delete process.env.COCALC_SPOT_RECOVERY_FAULTS_FILE;
    } else {
      process.env.COCALC_SPOT_RECOVERY_FAULTS_FILE = previous;
    }
  });

  function rules(value: any[]) {
    const path = join(dir, "faults.json");
    writeFileSync(path, JSON.stringify({ rules: value }));
    process.env.COCALC_SPOT_RECOVERY_FAULTS_FILE = path;
  }

  it("does nothing unless the faults file is configured", () => {
    delete process.env.COCALC_SPOT_RECOVERY_FAULTS_FILE;
    expect(
      injectedStartFault({
        host_id: "h",
        pricing: "spot",
        machine_type: "t2d-standard-2",
      }),
    ).toBeUndefined();
  });

  it("matches start faults and machine-type switch faults separately", () => {
    rules([
      { pricing: "spot", machine_type: "t2d-standard-2", error: "STOCKOUT" },
      {
        stage: "set_machine_type",
        machine_type: "n2d-standard-4",
        error: "socket hang up",
      },
    ]);
    const base = { host_id: "h", pricing: "spot" as const };
    expect(
      injectedStartFault({ ...base, machine_type: "t2d-standard-2" }),
    ).toBe("STOCKOUT");
    expect(
      injectedStartFault({
        ...base,
        machine_type: "t2d-standard-2",
        stage: "set_machine_type",
      }),
    ).toBeUndefined();
    expect(
      injectedStartFault({
        ...base,
        machine_type: "n2d-standard-4",
        stage: "set_machine_type",
      }),
    ).toBe("socket hang up");
    expect(
      injectedStartFault({ ...base, machine_type: "n2d-standard-4" }),
    ).toBeUndefined();
  });
});
