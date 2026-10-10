import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSensor, sensorArgv } from "./sensors";

const ids = {
  project_id: "11111111-1111-4111-8111-111111111111",
  sensor_id: "22222222-2222-4222-8222-222222222222",
  run_id: "33333333-3333-4333-8333-333333333333",
};

describe("runSensor", () => {
  it("runs the approved body in an ephemeral container with a clean environment", async () => {
    const exec = jest.fn(async () => ({
      stdout: '{"wake": true, "summary": "x"}\n',
      stderr: "",
      code: 0,
    }));
    const result = await runSensor(
      {
        ...ids,
        language: "python",
        script: "print('it''s')",
        timeout_seconds: 9999,
        path: "/home/user/work/a.chat",
      },
      exec as any,
    );
    expect(result).toEqual({
      exit_code: 0,
      timed_out: false,
      stdout: '{"wake": true, "summary": "x"}\n',
      stderr: "",
    });
    const opts = (exec.mock.calls[0] as any)[0];
    expect(opts).toMatchObject({
      project_id: ids.project_id,
      useEphemeral: true,
      cwd: "/home/user/work",
      // The timeout is capped at the contract's maximum.
      timeoutMs: 300_000 + 60_000,
    });
    expect(opts.env).toBeUndefined();
    const argv: string[] = opts.argv;
    expect(argv.slice(0, 2)).toEqual(["/usr/bin/env", "-i"]);
    expect(argv).toContain(
      `COCALC_SENSOR_STATE=/home/user/.local/share/cocalc/sensors/${ids.sensor_id}/state.json`,
    );
    const path = argv.find((arg) => arg.startsWith("PATH="))!;
    expect(path).not.toMatch(/\/home\/user/);
    expect(argv.slice(-5)).toEqual([
      "300",
      "python3",
      "-I",
      "-c",
      "print('it''s')",
    ]);
  });

  it("runs nothing the project controls before the body", () => {
    // Execute the real argv locally (without env -i's path to a container):
    // a planted BASH_ENV, profile and PATH entry must not run.
    const home = mkdtempSync(join(tmpdir(), "sensor-"));
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "timeout"), "#!/bin/sh\necho HIJACK\n", {
      mode: 0o755,
    });
    writeFileSync(join(home, "evil.sh"), "echo HIJACK\n");
    writeFileSync(join(home, ".bash_profile"), "echo HIJACK\n");
    const argv = sensorArgv(
      {
        project_id: ids.project_id,
        language: "sh",
        script: 'echo "body ran"; echo "$PATH"',
      },
      {
        sensor_id: ids.sensor_id,
        run_id: ids.run_id,
        seconds: 5,
        state: join(home, "state", "state.json"),
      },
    ).map((arg) => (arg.startsWith("HOME=") ? `HOME=${home}` : arg));
    const out = execFileSync(argv[0], argv.slice(1), {
      encoding: "utf8",
      env: {
        BASH_ENV: join(home, "evil.sh"),
        PATH: `${join(home, "bin")}:/usr/bin:/bin`,
      },
    });
    expect(out).not.toContain("HIJACK");
    expect(out).toContain("body ran");
    expect(readFileSync(join(home, "bin", "timeout"), "utf8")).toContain(
      "HIJACK",
    );
  });

  it("reports timeouts and refuses malformed requests", async () => {
    const exec = jest.fn(async () => ({ stdout: "", stderr: "", code: 124 }));
    const base = {
      language: "node" as const,
      script: "x",
      timeout_seconds: 5,
      path: "a.chat",
    };
    expect((await runSensor({ ...ids, ...base }, exec as any)).timed_out).toBe(
      true,
    );
    await expect(
      runSensor({ ...ids, ...base, sensor_id: "x" }, exec as any),
    ).rejects.toThrow(/invalid/);
    await expect(
      runSensor({ ...ids, ...base, language: "ruby" as any }, exec as any),
    ).rejects.toThrow(/language/);
  });
});
