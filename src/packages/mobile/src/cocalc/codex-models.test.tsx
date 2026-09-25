import { getProjectCodexModels } from "./codex-models";
import callHub from "@cocalc/conat/hub/call-hub";
import { resolveNamedAgentHost } from "@cocalc/chat-client/named-agents";
import { openProjectHost } from "./site-session";
jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("@cocalc/chat-client/named-agents", () => ({
  resolveNamedAgentHost: jest.fn(),
}));
jest.mock("./site-session", () => ({ openProjectHost: jest.fn() }));
it("discovers subscription models through the owning project host, not the hub placeholder", async () => {
  const hub = { projects: { getCodexUsageStatus: jest.fn() } };
  const session = { profile: { account_id: "account" }, hubApi: hub } as any;
  const client = {};
  jest.mocked(resolveNamedAgentHost).mockResolvedValue("host");
  jest.mocked(openProjectHost).mockResolvedValue({ client } as any);
  jest
    .mocked(callHub)
    .mockResolvedValue({ available: true, models: [{ model: "plan-model" }] });
  expect(
    (await getProjectCodexModels(session, "project", "credential")).models,
  ).toEqual([{ model: "plan-model" }]);
  expect(openProjectHost).toHaveBeenCalledWith(session, {
    project_id: "project",
    host_id: "host",
  });
  expect(callHub).toHaveBeenCalledWith({
    client,
    account_id: "account",
    name: "projects.getCodexUsageStatus",
    args: [
      {
        project_id: "project",
        include_models: true,
        credential_id: "credential",
        timeout: 90000,
      },
    ],
    timeout: 90000,
  });
  expect(hub.projects.getCodexUsageStatus).not.toHaveBeenCalled();
});
