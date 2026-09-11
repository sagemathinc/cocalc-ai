import {
  remoteKernelSetupArgs,
  setupRemoteKernel,
  suggestedEnvironment,
  probeRemoteKernel,
} from "./remote-kernel-service";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { project_client: { exec: jest.fn() } },
}));
const config = { name: "gpu", host: "jupyter", environment: "teaching" };

it("shows SSH stderr verbatim without command wrappers or JavaScript stacks", async () => {
  const stderr =
    "** WARNING: connection is not using a post-quantum key exchange algorithm.\n" +
    '** This session may be vulnerable to "store now, decrypt later" attacks.\n' +
    "** The server may need to be upgraded. See https://openssh.com/pq.html\n" +
    "user@vm.example.com: Permission denied (publickey).";
  (webapp_client.project_client.exec as jest.Mock).mockResolvedValue({
    exit_code: 1,
    stdout: "",
    stderr: `Error: SSH operation failed (255): ${stderr}\n    at ChildProcess.<anonymous> (file:///opt/cocalc/reflect.mjs:399:1037)\n    at ChildProcess.emit (node:events:514:28)\n`,
  });
  await expect(probeRemoteKernel("project", "gpu")).rejects.toEqual(
    Error(`~$ ssh gpu\n${stderr}`),
  );
  expect(webapp_client.project_client.exec).toHaveBeenLastCalledWith(
    expect.objectContaining({ err_on_exit: false, bash: false }),
  );
});

it.each([
  [
    "Error: Environment already exists\n    at setup (/reflect.mjs:1:2)",
    "Environment already exists",
  ],
  ["", "Remote kernel command failed (exit 1)."],
  [
    "SSH operation failed (1): Python is not installed",
    "SSH operation failed (1): Python is not installed",
  ],
])("preserves non-SSH setup diagnostics: %s", async (stderr, message) => {
  (webapp_client.project_client.exec as jest.Mock).mockResolvedValue({
    exit_code: 1,
    stdout: "",
    stderr,
  });
  await expect(setupRemoteKernel("project", config)).rejects.toEqual(
    Error(message),
  );
});

it("preserves transport errors instead of treating them as SSH failures", async () => {
  const error = Error("Project connection closed");
  (webapp_client.project_client.exec as jest.Mock).mockRejectedValue(error);
  await expect(probeRemoteKernel("project", "gpu")).rejects.toBe(error);
});

it("normalizes long environment names while retaining suffixes and existing semantics", () => {
  const padding = "-".repeat(100_000);
  expect(
    suggestedEnvironment(`${padding}Student@GPU${padding}`, "python", []),
  ).toBe("student-gpu-python");
  expect(suggestedEnvironment(padding, "pytorch-cu128", [])).toBe("remote-gpu");
  expect(suggestedEnvironment(`CPU${padding}GPU`, "python", [])).toBe(
    `cpu${"-".repeat(67)}-python`,
  );
  expect(suggestedEnvironment("--A__B--C--", "python", [])).toBe(
    "a__b--c-python",
  );
});

it("uses project-scoped execution with separate arguments and no shell", async () => {
  (webapp_client.project_client.exec as jest.Mock).mockResolvedValue({
    stdout: '{"kernel":"reflect-gpu"}',
  });
  expect(await setupRemoteKernel("project", config)).toBe("reflect-gpu");
  expect(webapp_client.project_client.exec).toHaveBeenCalledWith(
    expect.objectContaining({
      project_id: "project",
      bash: false,
      command: "reflect",
      args: remoteKernelSetupArgs(config),
    }),
  );
});

it.each([
  { ...config, name: "../escape" },
  { ...config, host: "-oProxyCommand=bad" },
  { ...config, host: "user@host\nother" },
  { ...config, python: "python3" },
])("rejects invalid setup fields", (value) => {
  expect(() => remoteKernelSetupArgs(value)).toThrow();
});

it("registers any language using a kernelspec, not a Python recipe", () => {
  const args = remoteKernelSetupArgs({
    ...config,
    kernel: "/opt/sagejs/kernel.json",
  });
  expect(args).toEqual(
    expect.arrayContaining(["--kernel", "/opt/sagejs/kernel.json"]),
  );
  expect(args).not.toContain("--recipe");
  expect(() =>
    remoteKernelSetupArgs({ ...config, kernel: "relative/kernel.json" }),
  ).toThrow();
  expect(() =>
    remoteKernelSetupArgs({
      ...config,
      kernel: "/kernel.json",
      python: "/bin/python",
    }),
  ).toThrow();
});

it("avoids unknown and incompatible environment names and reuses matching recipes", () => {
  expect(
    suggestedEnvironment("student@gpu", "pytorch-cu128", [
      { name: "student-gpu-gpu", recipe: null },
      { name: "student-gpu-gpu-2", recipe: "python" },
      { name: "student-gpu-gpu-3", recipe: "pytorch-cu128" },
    ]),
  ).toBe("student-gpu-gpu-3");
});
