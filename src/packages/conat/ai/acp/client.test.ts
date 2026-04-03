jest.mock("./server", () => ({
  acpAutomationSubject: () => "acp.test.automation",
  acpControlSubject: () => "acp.test.control",
  acpForkSubject: () => "acp.test.fork",
  acpInterruptSubject: () => "acp.test.interrupt",
  acpSubject: () => "acp.test.api",
}));

import {
  automationAcp,
  forkAcpSession,
  streamAcp,
} from "./client";

describe("acp client explicit routing", () => {
  it("requires an explicit client for streamAcp", async () => {
    const iterator = streamAcp({
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      path: "a.chat",
      input: "hello",
    } as any);

    await expect(iterator.next()).rejects.toThrow(
      "must provide an explicit Conat client",
    );
  });

  it("requires an explicit client for automationAcp", async () => {
    await expect(
      automationAcp({
        project_id: "00000000-0000-4000-8000-000000000000",
        account_id: "00000000-0000-4000-8000-000000000001",
        path: "a.chat",
        thread_id: "thread-1",
        action: "status",
      } as any),
    ).rejects.toThrow("must provide an explicit Conat client");
  });
});

describe("forkAcpSession", () => {
  it("accepts non-uuid session ids and returns non-uuid fork ids", async () => {
    const client = {
      request: jest.fn().mockResolvedValue({
        data: { sessionId: "thr-forked-2" },
      }),
    };

    await expect(
      forkAcpSession(
        {
          project_id: "00000000-0000-4000-8000-000000000000",
          account_id: "00000000-0000-4000-8000-000000000001",
          sessionId: "thr-shared-1",
        },
        client as any,
      ),
    ).resolves.toEqual({ sessionId: "thr-forked-2" });
  });

  it("rejects an empty session id", async () => {
    const client = {
      request: jest.fn(),
    };

    await expect(
      forkAcpSession(
        {
          project_id: "00000000-0000-4000-8000-000000000000",
          account_id: "00000000-0000-4000-8000-000000000001",
          sessionId: "   ",
        },
        client as any,
      ),
    ).rejects.toThrow("sessionId must be a non-empty string");
  });

  it("requires an explicit client", async () => {
    await expect(
      forkAcpSession({
        project_id: "00000000-0000-4000-8000-000000000000",
        account_id: "00000000-0000-4000-8000-000000000001",
        sessionId: "thr-shared-1",
      }),
    ).rejects.toThrow("must provide an explicit Conat client");
  });
});
