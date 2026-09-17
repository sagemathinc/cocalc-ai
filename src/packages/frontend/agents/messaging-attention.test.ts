import {
  loadMessagingAttention,
  messagingAttentionRecords,
} from "./messaging-attention";
import type { PersonalConnectionRequest } from "@cocalc/conat/agents/personal";
import type { AgentIdentity } from "@cocalc/conat/agents/protocol";

const mockApi = {
  listPersonalConnectionRequests: jest.fn(),
  listIdentities: jest.fn(),
};
jest.mock("./api", () => ({ personalAgentApi: () => mockApi }));
const context = { account_id: "P", project_id: "project", path: "/a.chat" };
const request = {
  account_id: "P",
  request_id: "request",
  source: { project_id: "project", agent_id: "source" },
  state: "pending",
  created_at: "2026-09-14T00:00:00Z",
  expires_at: "2099-01-01T00:00:00Z",
} as PersonalConnectionRequest;
const identity = {
  project_id: "project",
  agent_id: "source",
  path: "/a.chat",
  thread_id: "thread",
  disabled_at: null,
} as AgentIdentity;
beforeEach(() => jest.resetAllMocks());

test("projects the authoritative request into typed attention without a generic question", () => {
  const [record] = messagingAttentionRecords([request], [identity], context);
  expect(record).toMatchObject({
    attention_id: "agent-messaging:request",
    account_id: "P",
    project_id: "project",
    path: "/a.chat",
    thread_id: "thread",
    source_kind: "cocalc_action",
    attention_kind: "approval",
    questions: [],
    action: { kind: "agent_messaging", reference: "request" },
  });
  expect(record).not.toHaveProperty("target");
});

test("filters other humans/projects/files, missing identities, ended requests, and expiry", () => {
  for (const invalid of [
    { ...request, account_id: "Q" },
    { ...request, source: { ...request.source, project_id: "other" } },
    { ...request, state: "denied" },
    { ...request, expires_at: "2020-01-01T00:00:00Z" },
    { ...request, expires_at: "invalid" },
  ]) {
    expect(
      messagingAttentionRecords(
        [invalid as PersonalConnectionRequest],
        [identity],
        context,
      ),
    ).toEqual([]);
  }
  for (const identities of [
    [],
    [{ ...identity, disabled_at: "2026-09-14T00:00:00Z" }],
    [{ ...identity, path: "/b.chat" }],
  ]) {
    expect(messagingAttentionRecords([request], identities, context)).toEqual(
      [],
    );
  }
});

test("reads metadata for only the open project and does not fan out when no request applies", async () => {
  mockApi.listPersonalConnectionRequests.mockResolvedValue({
    enabled: true,
    requests: [request],
  });
  mockApi.listIdentities.mockResolvedValue([identity]);
  expect(await loadMessagingAttention(context)).toHaveLength(1);
  expect(mockApi.listIdentities).toHaveBeenCalledWith({
    project_id: "project",
  });
  mockApi.listIdentities.mockClear();
  mockApi.listPersonalConnectionRequests.mockResolvedValue({
    enabled: true,
    requests: [{ ...request, account_id: "Q" }],
  });
  expect(await loadMessagingAttention(context)).toEqual([]);
  expect(mockApi.listIdentities).not.toHaveBeenCalled();
  mockApi.listPersonalConnectionRequests.mockResolvedValue({
    enabled: false,
    requests: [request],
  });
  expect(await loadMessagingAttention(context)).toEqual([]);
  expect(mockApi.listIdentities).not.toHaveBeenCalled();
});
