/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  BUNDLED_COCALC_CLI_JS,
  BUNDLED_NODE,
  appStartFailure,
  resolveAppCommand,
} from "./cocalc-cli";

describe("resolveAppCommand", () => {
  const args = ["project", "browser", "serve"];
  const bundled = {
    exec: BUNDLED_NODE,
    args: [BUNDLED_COCALC_CLI_JS, ...args],
  };

  test("runs the bundled CLI with the bundled node, not cocalc on the PATH", () => {
    expect(
      resolveAppCommand(
        { exec: "cocalc", args },
        { env: {}, exists: () => true },
      ),
    ).toEqual(bundled);
  });

  test("the bundled wrappers also resolve to the bundled node", () => {
    for (const bin of [
      "/opt/cocalc/bin2/cocalc",
      "/opt/cocalc/bin2/cocalc-cli",
    ]) {
      expect(
        resolveAppCommand(
          { exec: "cocalc", args },
          { env: { COCALC_CLI_BIN: bin }, exists: () => true },
        ),
      ).toEqual(bundled);
    }
  });

  test("an explicit COCALC_CLI_BIN (Lite) wins, also inside a project", () => {
    const js = "/home/user/cocalc/src/packages/cli/dist/bin/cocalc.js";
    expect(
      resolveAppCommand(
        { exec: "cocalc", args },
        { env: { COCALC_CLI_BIN: js }, exists: () => true },
      ),
    ).toEqual({ exec: js, args });
    // ... and is ignored if it does not exist.
    expect(
      resolveAppCommand(
        { exec: "cocalc", args },
        { env: { COCALC_CLI_BIN: js }, exists: (path) => path !== js },
      ),
    ).toEqual(bundled);
  });

  test("keeps the PATH lookup when no CLI is known", () => {
    expect(
      resolveAppCommand(
        { exec: "cocalc", args },
        { env: {}, exists: (path) => path !== BUNDLED_NODE },
      ),
    ).toEqual({ exec: "cocalc", args });
  });

  test("leaves other commands alone", () => {
    const command = { exec: "jupyter", args: ["lab"] };
    expect(resolveAppCommand(command, { env: {}, exists: () => true })).toBe(
      command,
    );
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
