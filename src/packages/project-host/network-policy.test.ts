/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const executeCode = jest.fn();

jest.mock("@cocalc/backend/execute-code", () => ({
  executeCode: (...args: any[]) => executeCode(...args),
}));

import {
  prepareProjectNetworkPolicy,
  projectNetworkPolicyFromRunQuota,
  setProjectNetworkPolicy,
} from "./network-policy";

describe("project network policy", () => {
  const project_id = "9ddaa0ac-262a-4b57-b829-e6c531324c01";

  beforeEach(() => {
    jest.clearAllMocks();
    executeCode.mockResolvedValue({ stdout: "", stderr: "", exit_code: 0 });
  });

  it("only enables network access for an explicit entitlement", () => {
    expect(projectNetworkPolicyFromRunQuota({ network: true })).toBe("normal");
    expect(projectNetworkPolicyFromRunQuota({ network: 1 })).toBe("normal");
    expect(projectNetworkPolicyFromRunQuota({ network: false })).toBe(
      "disabled",
    );
    expect(projectNetworkPolicyFromRunQuota({})).toBe("disabled");
    expect(projectNetworkPolicyFromRunQuota(undefined)).toBe("disabled");
    expect(projectNetworkPolicyFromRunQuota("not-json")).toBe("disabled");
  });

  it("persists startup policy without requesting a host-wide reconcile", async () => {
    await prepareProjectNetworkPolicy({ project_id, policy: "disabled" });

    expect(executeCode).toHaveBeenCalledWith({
      command: "sudo",
      args: [
        "-n",
        "/usr/local/sbin/cocalc-runtime-storage",
        "prepare-project-network-policy",
        project_id,
        "disabled",
      ],
      timeout: 60,
      err_on_exit: false,
    });
  });

  it("uses the reconciling command for a live policy change", async () => {
    await setProjectNetworkPolicy({ project_id, policy: "normal" });

    expect(executeCode).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining([
          "set-project-network-policy",
          project_id,
          "normal",
        ]),
      }),
    );
  });

  it("blocks startup when the privileged policy helper fails", async () => {
    executeCode.mockResolvedValue({
      stdout: "",
      stderr: "nft unavailable",
      exit_code: 1,
    });

    await expect(
      prepareProjectNetworkPolicy({ project_id, policy: "disabled" }),
    ).rejects.toThrow("nft unavailable");
  });
});
