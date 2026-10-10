import { execFileSync } from "node:child_process";
import { runSensor } from "./sensors";

const ids = {
  project_id: "11111111-1111-4111-8111-111111111111",
  sensor_id: "22222222-2222-4222-8222-222222222222",
  run_id: "33333333-3333-4333-8333-333333333333",
};

describe("runSensor", () => {
  it("runs the approved body in an ephemeral container with the sensor environment", async () => {
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
      env: {
        COCALC_SENSOR_ID: ids.sensor_id,
        COCALC_SENSOR_RUN_ID: ids.run_id,
        COCALC_SENSOR_STATE: `/home/user/.local/share/cocalc/sensors/${ids.sensor_id}/state.json`,
      },
      // The timeout is capped at the contract's maximum.
      timeoutMs: 300_000 + 60_000,
    });
    expect(opts.script).toContain("cd '/home/user/work'");
    expect(opts.script).toContain("timeout -k 5 300 bash -c ");
  });

  it("quotes the body so the shell passes it through unchanged", async () => {
    const exec = jest.fn(async () => ({ stdout: "", stderr: "", code: 0 }));
    const body = `echo "a'b" $HOME \`date\` ; exit 3`;
    await runSensor(
      {
        ...ids,
        language: "sh",
        script: body,
        timeout_seconds: 60,
        path: "a.chat",
      },
      exec as any,
    );
    const script: string = (exec.mock.calls[0] as any)[0].script;
    const inner = script
      .split("\n")
      .at(-1)!
      .replace(/^timeout -k 5 60 /, "");
    // Evaluate the quoted command without running it: print its arguments.
    const args = execFileSync(
      "bash",
      ["-c", `set -- ${inner.replace(/^bash -c /, "")}; printf '%s' "$1"`],
      { encoding: "utf8" },
    );
    const innerArgs = execFileSync(
      "bash",
      [
        "-c",
        `set -- ${args.replace(/^exec bash -c /, "").replace(/ sensor$/, "")}; printf '%s' "$1"`,
      ],
      { encoding: "utf8" },
    );
    expect(innerArgs).toBe(body);
  });

  it("reports timeouts and refuses malformed requests", async () => {
    const exec = jest.fn(async () => ({ stdout: "", stderr: "", code: 124 }));
    expect(
      (
        await runSensor(
          {
            ...ids,
            language: "node",
            script: "x",
            timeout_seconds: 5,
            path: "a.chat",
          },
          exec as any,
        )
      ).timed_out,
    ).toBe(true);
    await expect(
      runSensor(
        {
          ...ids,
          sensor_id: "x",
          language: "sh",
          script: "x",
          timeout_seconds: 5,
          path: "a.chat",
        },
        exec as any,
      ),
    ).rejects.toThrow(/invalid/);
    await expect(
      runSensor(
        {
          ...ids,
          language: "ruby" as any,
          script: "x",
          timeout_seconds: 5,
          path: "a.chat",
        },
        exec as any,
      ),
    ).rejects.toThrow(/language/);
  });
});
