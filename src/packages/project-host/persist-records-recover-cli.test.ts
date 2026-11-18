/*
The operator command `persist-records-recover [--apply]` (028 ALT-D2, ops0's
S4 ruling; backend/conat/persist-records-recovery.md), as the runbook runs
it: the project-host entry's command, with the daemon's environment (its env
file), against a records root whose set-up failed.  [RECOVERY-CLI]
*/

import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateRecordsGate } from "@cocalc/backend/conat/persist-records-root";
import { runPersistRecordsRecoverCommand } from "./persist-records-recover-cli";

const VARS = [
  "COCALC_PERSIST_RECORDS_BASE",
  "COCALC_PERSIST_RECORDS_ALLOW_TEST_PATHS",
  "COCALC_PERSIST_STATE_DIR",
  "COCALC_PERSIST_RUN_DIR",
  "COCALC_SYNC",
  "COCALC_DATA_DIR",
  "COCALC_DATA",
  "DATA",
  "COCALC_BAY_STATE_DIR",
  "COCALC_PROJECT_HOST_DAEMON_ENV_FILE",
  "COCALC_PROJECT_HOST_DAEMON_LOCAL_ENV_FILE",
];

describe("[RECOVERY-CLI] persist-records-recover, the project-host command", () => {
  let root: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "persist-recover-cli-"));
    for (const k of VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of VARS) {
      if (saved[k] == null) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("[RECOVERY-CLI] resolves the paths from the daemon's env file; dry run, then --apply; the gate then migrates", () => {
    const data = join(root, "data");
    fs.mkdirSync(data, { mode: 0o700 });
    const envFile = join(root, "project-host.env");
    fs.writeFileSync(
      envFile,
      `COCALC_DATA=${data}\nCOCALC_PERSIST_RUN_DIR=${join(root, "no-legacy")}\n`,
    );
    process.env.COCALC_PROJECT_HOST_DAEMON_ENV_FILE = envFile;
    process.env.COCALC_PROJECT_HOST_DAEMON_LOCAL_ENV_FILE = join(root, "absent.env");
    const base = join(data, "persist-durability");
    // DATA is what the daemon also sets from COCALC_DATA
    const state = join(data, "sync", ".cocalc-persist-state");
    // a set-up that failed: marker A's rename (the real boot id)
    const gateEnv = {
      COCALC_DATA: data,
      DATA: data,
      COCALC_PERSIST_RUN_DIR: join(root, "no-legacy"),
      COCALC_PERSIST_RECORDS_ALLOW_TEST_PATHS: "1",
      COCALC_TEST_MODE: "1",
    };
    const failing = new Proxy({} as any, {
      get: (_t, op: string) => (...args: any[]) => {
        if (op === "renameSync" && `${args[1]}` === join(base, "marker.json")) {
          throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
        }
        return (fs as any)[op](...args);
      },
    });
    expect(
      evaluateRecordsGate({ env: gateEnv, stateDir: state, retries: 0, fs: failing }),
    ).toMatchObject({ ok: false, code: "records_write_failed" });
    expect(evaluateRecordsGate({ env: gateEnv, stateDir: state, retries: 0 })).toMatchObject({
      ok: false,
      code: "marker_copy_missing",
    });
    // the dry run, as printed by the runbook
    let out = "";
    expect(runPersistRecordsRecoverCommand([], (s) => (out += s))).toBe(0);
    const dry = JSON.parse(out);
    expect(dry).toMatchObject({ ok: true, base, stateDir: state, applied: [] });
    expect(dry.plan[dry.plan.length - 1]).toBe(join(state, "records-migrated.json"));
    expect(fs.existsSync(join(state, "records-marker.json"))).toBe(true);
    // a wrong argument changes nothing
    out = "";
    expect(runPersistRecordsRecoverCommand(["--aply"], (s) => (out += s))).toBe(2);
    expect(out).toMatch(/^usage: persist-records-recover \[--apply\]/);
    // --apply
    out = "";
    expect(runPersistRecordsRecoverCommand(["--apply"], (s) => (out += s))).toBe(0);
    expect(JSON.parse(out).applied).toEqual(dry.plan);
    expect(evaluateRecordsGate({ env: gateEnv, stateDir: state, retries: 0 })).toMatchObject({
      ok: true,
      migrated: true,
      t1: "pass",
    });
    // and on the now complete set-up it refuses to act
    out = "";
    expect(runPersistRecordsRecoverCommand(["--apply"], (s) => (out += s))).toBe(2);
    expect(JSON.parse(out).stop).toMatch(/^not a failed creation/);
  });

  it("[RECOVERY-CLI-main] main.ts dispatches the command first, before any process title, cgroup or daemon branch", () => {
    const src = fs.readFileSync(join(__dirname, "main.ts"), "utf8");
    const m = /if \(require\.main === module\) \{\n([^]*?)\n  applyProjectHostProcessTitle\(\);/.exec(src);
    expect(m).not.toBeNull();
    expect(m![1]).toContain("if (process.argv[2] === PERSIST_RECORDS_RECOVER_COMMAND) {");
    expect(m![1]).toContain("process.exit(runPersistRecordsRecoverCommand(process.argv.slice(3)));");
    expect(src).toMatch(/^import \{\n  PERSIST_RECORDS_RECOVER_COMMAND,\n  runPersistRecordsRecoverCommand,\n\} from "\.\/persist-records-recover-cli";$/m);
  });
});
