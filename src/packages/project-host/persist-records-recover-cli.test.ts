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
    // the persist's own diag values, as the runbook passes them
    const diag = ["--base", base, "--state-dir", state];
    let out = "";
    // without them: usage, nothing done
    expect(runPersistRecordsRecoverCommand([], (s) => (out += s))).toBe(2);
    expect(out).toMatch(/^usage: persist-records-recover --base <records_base> --state-dir <records_state_dir> \[--apply\]  \(--base and --state-dir are required\)/);
    // a state dir that is not the persist's: it stops, nothing done
    out = "";
    expect(runPersistRecordsRecoverCommand(["--base", base, "--state-dir", join(root, "x")], (s) => (out += s))).toBe(2);
    expect(JSON.parse(out).stop).toMatch(/are not the persist's own/);
    out = "";
    expect(runPersistRecordsRecoverCommand(diag, (s) => (out += s))).toBe(0);
    const dry = JSON.parse(out);
    expect(dry).toMatchObject({ ok: true, base, stateDir: state, applied: [] });
    expect(dry.plan[dry.plan.length - 1]).toBe(join(state, "records-migrated.json"));
    expect(fs.existsSync(join(state, "records-marker.json"))).toBe(true);
    // a wrong argument changes nothing
    out = "";
    expect(runPersistRecordsRecoverCommand([...diag, "--aply"], (s) => (out += s))).toBe(2);
    expect(out).toMatch(/^usage: persist-records-recover --base/);
    // --apply
    out = "";
    expect(runPersistRecordsRecoverCommand([...diag, "--apply"], (s) => (out += s))).toBe(0);
    expect(JSON.parse(out).applied).toEqual(dry.plan);
    expect(evaluateRecordsGate({ env: gateEnv, stateDir: state, retries: 0 })).toMatchObject({
      ok: true,
      migrated: true,
      t1: "pass",
    });
    // and on the now complete set-up it refuses to act
    out = "";
    expect(runPersistRecordsRecoverCommand([...diag, "--apply"], (s) => (out += s))).toBe(2);
    expect(JSON.parse(out).stop).toMatch(/^not a failed creation/);
  });

  it("[RECOVERY-CLI-main] main.ts dispatches the command first, in its own branch: nothing else of main runs, and the process ends when the report is written", () => {
    const src = fs.readFileSync(join(__dirname, "main.ts"), "utf8");
    expect(src).toContain(
      "if (require.main === module && process.argv[2] === PERSIST_RECORDS_RECOVER_COMMAND) {\n" +
        "  // an operator command (028 ALT-D2): nothing else starts; the process ends\n" +
        "  // once its report is written\n" +
        "  mainPersistRecordsRecover(process.argv.slice(3));\n" +
        "} else if (require.main === module) {\n" +
        "  applyProjectHostProcessTitle();",
    );
    // the only `require.main === module` dispatch in main.ts
    expect(src.match(/require\.main === module/g)).toHaveLength(2);
    expect(src).not.toMatch(/process\.exit\(runPersistRecordsRecoverCommand/);
  });
});
