/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  BUNDLED_COCALC_CLI_JS,
  appStartFailure,
  resolveAppCommand,
} from "./cocalc-cli";

describe("resolveAppCommand", () => {
  const execPath = "/opt/cocalc/bin/node";
  const args = ["project", "browser", "serve"];

  test("runs the bundled CLI with this node, not cocalc on the PATH", () => {
    expect(
      resolveAppCommand(
        { exec: "cocalc", args },
        {
          env: { COCALC_CLI_BIN: "/home/user/.local/bin/cocalc" },
          execPath,
          exists: () => true,
        },
      ),
    ).toEqual({ exec: execPath, args: [BUNDLED_COCALC_CLI_JS, ...args] });
  });

  test("falls back to COCALC_CLI_BIN without the bundled CLI (Lite)", () => {
    const js = "/lite/cli/dist/bin/cocalc.js";
    const exists = (path: string) => path !== BUNDLED_COCALC_CLI_JS;
    expect(
      resolveAppCommand(
        { exec: "cocalc", args },
        { env: { COCALC_CLI_BIN: js }, execPath, exists },
      ),
    ).toEqual({ exec: execPath, args: [js, ...args] });
    expect(
      resolveAppCommand(
        { exec: "cocalc", args },
        { env: { COCALC_CLI_BIN: "/lite/bin/cocalc" }, execPath, exists },
      ),
    ).toEqual({ exec: "/lite/bin/cocalc", args });
  });

  test("keeps the PATH lookup when no CLI is known", () => {
    expect(
      resolveAppCommand(
        { exec: "cocalc", args },
        { env: {}, execPath, exists: () => false },
      ),
    ).toEqual({ exec: "cocalc", args });
  });

  test("leaves other commands alone", () => {
    const command = { exec: "jupyter", args: ["lab"] };
    expect(
      resolveAppCommand(command, { env: {}, execPath, exists: () => true }),
    ).toBe(command);
  });
});

describe("appStartFailure", () => {
  const enoent = Object.assign(new Error("spawn cocalc ENOENT"), {
    code: "ENOENT",
  });

  test("says plainly when the CoCalc CLI is missing", () => {
    expect(appStartFailure({ exec: "cocalc", spawnError: enoent })).toMatch(
      /CoCalc CLI was not found/,
    );
    expect(appStartFailure({ exec: "jupyter", spawnError: enoent })).toBe(
      "command not found: jupyter",
    );
  });

  test("reports exits and has nothing to say while running", () => {
    expect(
      appStartFailure({ exec: "cocalc", exit: { code: 1, signal: null } }),
    ).toBe("cocalc exited with code 1");
    expect(
      appStartFailure({
        exec: "cocalc",
        exit: { code: null, signal: "SIGKILL" },
      }),
    ).toBe("cocalc was killed by SIGKILL");
    expect(appStartFailure({ exec: "cocalc" })).toBeUndefined();
  });
});
