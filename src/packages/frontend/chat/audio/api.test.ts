import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  clearChatSpeechCapabilityCache,
  getChatSpeechCapabilities,
} from "./api";

let mockLite = false;
jest.mock("@cocalc/frontend/lite", () => ({
  get lite() {
    return mockLite;
  },
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: { hub: { system: { getChatSpeechCapabilities: jest.fn() } } },
  },
}));

beforeEach(() => {
  mockLite = false;
  clearChatSpeechCapabilityCache();
  jest.clearAllMocks();
});

it("returns no Lite capabilities without calling the unimplemented RPC", async () => {
  mockLite = true;
  const capabilities = await getChatSpeechCapabilities("project");
  expect(capabilities.input.enabled).toBe(false);
  expect(capabilities.output.enabled).toBe(false);
  expect(
    webapp_client.conat_client.hub.system.getChatSpeechCapabilities,
  ).not.toHaveBeenCalled();
});

it("still queries and caches hosted capabilities", async () => {
  const rpc = jest.mocked(
    webapp_client.conat_client.hub.system.getChatSpeechCapabilities,
  );
  const capabilities = {
    input: { enabled: true },
    output: { enabled: true },
  } as any;
  rpc.mockResolvedValue(capabilities);
  expect(await getChatSpeechCapabilities("project")).toBe(capabilities);
  expect(await getChatSpeechCapabilities("project")).toBe(capabilities);
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith({ project_id: "project" });
});
