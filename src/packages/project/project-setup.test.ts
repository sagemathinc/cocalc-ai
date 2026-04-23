/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/project/logger", () => ({
  getLogger: () => ({
    debug: jest.fn(),
  }),
}));

import { cleanup, set_extra_env } from "./project-setup";

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("project environment cleanup", () => {
  afterEach(() => restoreEnv());

  test("preserves proxy listener settings while removing unrelated CoCalc env", () => {
    process.env.PATH = "/usr/bin:/bin";
    process.env.COCALC_PROXY_HOST = "0.0.0.0";
    process.env.COCALC_PROXY_PORT = "18080";
    process.env.COCALC_EXTRA_ENV = Buffer.from(
      JSON.stringify({ FOO: "bar" }),
    ).toString("base64");
    process.env.COCALC_PROJECT_ID = "test-project";
    process.env.COCALC_SECRET_TOKEN = "/tmp/secret-token";
    process.env.COCALC_LOGS = "/home/user/.cache/cocalc/project";

    cleanup();

    expect(process.env.COCALC_PROXY_HOST).toBe("0.0.0.0");
    expect(process.env.COCALC_PROXY_PORT).toBe("18080");
    expect(process.env.COCALC_EXTRA_ENV).toBeDefined();
    expect(process.env.COCALC_PROJECT_ID).toBeUndefined();
    expect(process.env.COCALC_SECRET_TOKEN).toBeUndefined();
    expect(process.env.COCALC_LOGS).toBeUndefined();
  });

  test("applies custom env after cleanup and consumes the encoded payload", () => {
    process.env.PATH = "/usr/bin:/bin";
    process.env.COCALC_EXTRA_ENV = Buffer.from(
      JSON.stringify({
        FOO: "bar",
        EMPTY: "",
        PATH: "/opt/example/bin:$PATH",
      }),
    ).toString("base64");

    cleanup();
    const applied = set_extra_env();

    expect(applied).toEqual({
      FOO: "bar",
      PATH: "/opt/example/bin:/usr/bin:/bin",
    });
    expect(process.env.FOO).toBe("bar");
    expect(process.env.EMPTY).toBeUndefined();
    expect(process.env.PATH).toBe("/opt/example/bin:/usr/bin:/bin");
    expect(process.env.COCALC_EXTRA_ENV).toBeUndefined();
  });
});
