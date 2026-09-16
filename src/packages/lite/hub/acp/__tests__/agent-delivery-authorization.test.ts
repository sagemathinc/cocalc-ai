import type { AcpRequest } from "@cocalc/conat/ai/acp/types";
import { authorizeAgentDeliveryExecution } from "../agent-delivery-authorization";

const request = (): AcpRequest => ({
  account_id: "recipient",
  project_id: "project",
  session_id: "session",
  prompt: "message",
  chat: {
    project_id: "project",
    path: "/home/user/recv.chat",
    thread_id: "thread",
    message_date: "2026-09-12T00:00:00.000Z",
    sender_id: "agent",
    agent_delivery_id: "delivery",
    agent_delivery_generation: "generation",
  },
});

test.each([true, false])(
  "legacy queued work fails closed, with generation=%s",
  async (generation) => {
    const value = request();
    if (!generation) delete value.chat!.agent_delivery_generation;
    const api = {
      authorizeDelivery: jest.fn(async () => {}),
      authorizeRpcExecution: jest.fn(async () => {}),
    };
    await expect(authorizeAgentDeliveryExecution(value, api)).rejects.toThrow(
      "Legacy agent delivery is retired",
    );
    expect(api.authorizeDelivery).not.toHaveBeenCalled();
  },
);
test("ordinary human and RPC requests do not acquire legacy semantics", async () => {
  const value = request();
  delete value.chat!.agent_delivery_id;
  const api = {
    authorizeDelivery: jest.fn(async () => {}),
    authorizeRpcExecution: jest.fn(async () => {}),
  };
  await authorizeAgentDeliveryExecution(value, api);
  expect(api.authorizeDelivery).not.toHaveBeenCalled();
});

test("RPC queued work is reauthorized at execution", async () => {
  const value = request();
  delete value.chat!.agent_delivery_id;
  value.chat!.agent_rpc_execution = {
    version: 2,
    source: {
      agent_id: "00000000-0000-4000-8000-000000000001",
      project_id: "00000000-0000-4000-8000-000000000002",
    },
    source_run_id: "00000000-0000-4000-8000-000000000003",
    target: {
      agent_id: "00000000-0000-4000-8000-000000000004",
      project_id: "00000000-0000-4000-8000-000000000005",
    },
    target_path: "/home/user/recv.chat",
    target_thread_id: "thread",
    link_id: "00000000-0000-4000-8000-000000000006",
    principal_account_id: "00000000-0000-4000-8000-000000000007",
    guidance: false,
  };
  const api = {
    authorizeDelivery: jest.fn(async () => {}),
    authorizeRpcExecution: jest.fn(async () => {}),
  };
  await authorizeAgentDeliveryExecution(value, api);
  expect(api.authorizeRpcExecution).toHaveBeenCalledWith({
    account_id: value.chat!.agent_rpc_execution.principal_account_id,
    authorization: value.chat!.agent_rpc_execution,
  });
});
