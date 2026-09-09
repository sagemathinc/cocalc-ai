import {
  remoteKernelSetupArgs,
  setupRemoteKernel,
} from "./remote-kernel-service";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { project_client: { exec: jest.fn() } },
}));
const config = { name: "gpu", host: "jupyter", environment: "teaching" };

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
