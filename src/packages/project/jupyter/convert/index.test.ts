/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const executeCodeMock = jest.fn();

jest.mock("@cocalc/backend/execute-code", () => ({
  executeCode: (...args: any[]) => executeCodeMock(...args),
}));

jest.mock("@cocalc/project/logger", () => ({
  getLogger: () => ({
    debug: jest.fn(),
    warn: jest.fn(),
  }),
}));

import { nbconvert } from "./index";

const opts = {
  args: ["--to", "html", "notebook.ipynb"],
  directory: "/home/user",
  timeout: 30,
};

describe("nbconvert command", () => {
  beforeEach(() => {
    executeCodeMock.mockReset();
  });

  it("runs nbconvert through the default Python module", async () => {
    executeCodeMock.mockResolvedValue({
      stdout: "",
      stderr: "",
      exit_code: 0,
    });

    await expect(nbconvert({ ...opts, args: [...opts.args] })).resolves.toEqual(
      {
        output: "/home/user/notebook.html",
      },
    );
    expect(executeCodeMock).toHaveBeenCalledTimes(1);
    expect(executeCodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "python3",
        args: ["-m", "nbconvert", "--to", "html", "notebook.ipynb"],
      }),
    );
  });

  it("reports conversion failures", async () => {
    executeCodeMock.mockResolvedValue({
      stdout: "",
      stderr: "notebook conversion failed",
      exit_code: 1,
    });

    await expect(nbconvert({ ...opts, args: [...opts.args] })).rejects.toThrow(
      "notebook conversion failed",
    );
    expect(executeCodeMock).toHaveBeenCalledTimes(1);
  });
});
