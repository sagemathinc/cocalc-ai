/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const spawnMock = jest.fn();
const writeFileMock = jest.fn(async () => undefined);
const warnMock = jest.fn();

jest.mock("node:child_process", () => ({
  spawn: (...args) => spawnMock(...args),
}));

jest.mock("node:fs", () => ({
  ...jest.requireActual("node:fs"),
  openSync: jest.fn(() => 11),
}));

jest.mock("node:fs/promises", () => ({
  writeFile: (...args) => writeFileMock(...args),
}));

jest.mock("./logger", () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: (...args) => warnMock(...args),
  }),
}));

jest.mock("./data", () => ({
  SSH_LOG: "/tmp/cocalc-sshd-test.log",
  SSH_ERR: "/tmp/cocalc-sshd-test.err",
}));

import { init } from "./sshd";

describe("project sshd initialization", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    spawnMock.mockReturnValue({ unref: jest.fn() });
    process.env = { ...originalEnv };
    delete process.env.COCALC_PROJECT_SSH_START_SCRIPT;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("does not fall back to legacy KuCalc sshd startup", async () => {
    await init();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(
      "COCALC_PROJECT_SSH_START_SCRIPT is not set; not starting sshd",
    );
  });

  it("spawns the runner-provided ssh startup script", async () => {
    process.env.COCALC_PROJECT_SSH_START_SCRIPT =
      "/home/user/.ssh/.cocalc/sshd/start-project-ssh.sh";

    await init();

    expect(spawnMock).toHaveBeenCalledWith(
      "bash",
      ["/home/user/.ssh/.cocalc/sshd/start-project-ssh.sh"],
      expect.objectContaining({
        detached: true,
        stdio: ["ignore", 11, 11],
      }),
    );
  });
});
