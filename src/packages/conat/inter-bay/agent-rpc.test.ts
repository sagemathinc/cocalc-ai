const createClient = jest.fn(() => ({}));
jest.mock("@cocalc/conat/service/typed", () => ({
  createServiceClient: (options) => createClient(options),
  createServiceHandler: jest.fn(),
}));

import { createAgentRpcControlClient } from "./agent-rpc";

test("cross-bay sends cannot inherit fast-RPC fallback or automatic retries", () => {
  const client = {} as any;
  createAgentRpcControlClient(client, "bay-2");
  expect(createClient).toHaveBeenCalledWith({
    client,
    service: "agent-messaging-v3",
    subject: "bay.bay-2.rpc.agent-messaging.v3",
    transport: "request",
    noRetry: true,
    timeout: 45000,
  });
  expect(() => createAgentRpcControlClient(client, "bay.*")).toThrow();
});
