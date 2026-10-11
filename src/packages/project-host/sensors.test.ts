import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSensor, sensorArgv, SENSOR_CREDENTIALS_DIR } from "./sensors";

const ids = {
  project_id: "11111111-1111-4111-8111-111111111111",
  sensor_id: "22222222-2222-4222-8222-222222222222",
  run_id: "33333333-3333-4333-8333-333333333333",
};
const credentials = {
  identity: {
    agent_id: "44444444-4444-4444-8444-444444444444",
    run_id: ids.run_id,
    token: "cocalc_agent_identity_x",
    expires_at: Date.now() + 600_000,
  },
  bearer: "bearer-token",
};

describe("runSensor", () => {
  let runsRoot: string;
  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "sensor-runs-"));
  });

  it("runs like an agent command: project software, run credentials, nothing else", async () => {
    let seenDir: string | undefined;
    const exec = jest.fn(async (opts: any) => {
      // The credentials exist while the script runs.
      seenDir = opts.extraMounts[0].source;
      expect(readFileSync(join(seenDir!, "token"), "utf8")).toBe(
        "bearer-token\n",
      );
      expect(
        JSON.parse(readFileSync(join(seenDir!, "identity.json"), "utf8")),
      ).toEqual(credentials.identity);
      expect(readFileSync(join(seenDir!, "connector-key"), "utf8").trim()).toBe(
        "connector-secret",
      );
      expect(statSync(join(seenDir!, "token")).mode & 0o077).toBe(0);
      return {
        stdout: '{"wake": true, "summary": "x"}\n',
        stderr: "",
        code: 0,
      };
    });
    const result = await runSensor(
      {
        ...ids,
        language: "python",
        script: "print('hi')",
        timeout_seconds: 9999,
        path: "/home/user/work/a.chat",
        image: "project-image:1",
        credentials: { ...credentials, connector_key: "connector-secret" },
      },
      { exec: exec as any, apiUrl: "http://hub:9100", runsRoot },
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
      image: "project-image:1",
      noNewPrivileges: true,
      tmpfs: ["/tmp", "/home/user/.local/share/cocalc/runtime"],
      extraMounts: [{ target: SENSOR_CREDENTIALS_DIR, readOnly: true }],
      // The timeout is capped at the contract's maximum.
      timeoutMs: 300_000 + 60_000,
      env: {
        COCALC_SENSOR_ID: ids.sensor_id,
        COCALC_SENSOR_RUN_ID: ids.run_id,
        COCALC_SENSOR_STATE: `/home/user/.local/share/cocalc/sensors/${ids.sensor_id}/state.json`,
        COCALC_AGENT_IDENTITY_FILE: `${SENSOR_CREDENTIALS_DIR}/identity.json`,
        COCALC_BEARER_TOKEN_FILE: `${SENSOR_CREDENTIALS_DIR}/token`,
        COCALC_AGENT_TOKEN_FILE: `${SENSOR_CREDENTIALS_DIR}/token`,
        COCALC_CONNECTOR_API_KEY_FILE: `${SENSOR_CREDENTIALS_DIR}/connector-key`,
        COCALC_API_URL: "http://hub:9100",
      },
      pathPrefix: [],
    });
    expect(opts.argv.slice(-4)).toEqual([
      "300",
      "python3",
      "-c",
      "print('hi')",
    ]);
    // Removed when the run ends.
    expect(existsSync(seenDir!)).toBe(false);
  });

  it("gives CLI connector wrappers only when the run has connector tokens", async () => {
    const exec = jest.fn(async (opts: any) => {
      const bin = join(opts.extraMounts[0].source, "cli", "bin");
      expect(existsSync(join(bin, "gh"))).toBe(true);
      expect(existsSync(join(bin, "cf"))).toBe(false);
      return { stdout: "", stderr: "", code: 0 };
    });
    await runSensor(
      {
        ...ids,
        language: "sh",
        script: "gh issue list",
        timeout_seconds: 30,
        path: "a.chat",
        image: "",
        credentials: {
          ...credentials,
          cli_tokens: [
            {
              connector: "github",
              token: "ghu_x",
              expires_at: Date.now() + 3_600_000,
              description: "@octocat",
            },
          ],
        },
      },
      { exec: exec as any, apiUrl: "http://hub", runsRoot },
    );
    const opts = (exec.mock.calls[0] as any)[0];
    expect(opts.pathPrefix).toEqual([`${SENSOR_CREDENTIALS_DIR}/cli/bin`]);
    expect(opts.env.COCALC_CONNECTOR_API_KEY_FILE).toBeUndefined();
  });

  it("passes the body through the shell unchanged", () => {
    const body = `echo "a'b" $HOME \`date\` ; exit 3`;
    const argv = sensorArgv({ language: "sh", script: body }, 5);
    // Run the real command line with a stand-in for timeout: print the body.
    const out = execFileSync(
      "/bin/bash",
      [
        "-c",
        argv[2].replace("exec timeout -k 5", "printf '%s' \"$3\" #"),
        ...argv.slice(3),
      ],
      {
        encoding: "utf8",
        env: { COCALC_SENSOR_STATE: join(runsRoot, "s", "state.json") },
      },
    );
    expect(out).toBe(body);
  });

  it("reports timeouts, cleans up on failure, and refuses malformed requests", async () => {
    const base = {
      ...ids,
      language: "node" as const,
      script: "x",
      timeout_seconds: 5,
      path: "a.chat",
      image: "",
      credentials,
    };
    const timeout = jest.fn(async () => ({
      stdout: "",
      stderr: "",
      code: 124,
    }));
    expect(
      (await runSensor(base, { exec: timeout as any, apiUrl: "x", runsRoot }))
        .timed_out,
    ).toBe(true);
    const boom = jest.fn(async () => {
      throw new Error("podman failed");
    });
    await expect(
      runSensor(base, { exec: boom as any, apiUrl: "x", runsRoot }),
    ).rejects.toThrow("podman failed");
    expect(existsSync(join(runsRoot, ids.run_id))).toBe(false);
    await expect(
      runSensor(
        { ...base, sensor_id: "x" },
        { exec: timeout as any, runsRoot },
      ),
    ).rejects.toThrow(/invalid/);
    await expect(
      runSensor(
        { ...base, credentials: { ...credentials, bearer: "" } },
        { exec: timeout as any, runsRoot },
      ),
    ).rejects.toThrow(/credentials/);
  });
});
