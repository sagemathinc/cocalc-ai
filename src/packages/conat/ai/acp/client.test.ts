import {
  automationAcp,
  forkAcpSession,
  interruptAcp,
  steerAcp,
  streamAcp,
  truncateAcpSession,
} from "./client";

describe("acp client explicit routing", () => {
  it("routes harness requests to a versioned subject with no native fallback", async () => {
    const request: any = {
      project_id: "00000000-0000-4000-8000-000000000000",
      account_id: "00000000-0000-4000-8000-000000000001",
      prompt: "hello",
      runtime: { version: 1, kind: "acp", profile: {} },
    };
    const requestMany = jest.fn().mockRejectedValue(Error("no responders"));
    await expect(
      streamAcp(request, {}, { requestMany } as any).next(),
    ).rejects.toThrow("no responders");
    expect(requestMany).toHaveBeenCalledTimes(1);
    expect(requestMany.mock.calls[0][0]).toMatch(/\.harness-v1$/);
  });

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

  it("requires an explicit client for steerAcp", async () => {
    await expect(
      steerAcp({
        project_id: "00000000-0000-4000-8000-000000000000",
        account_id: "00000000-0000-4000-8000-000000000001",
        prompt: "focus on tests",
        chat: {
          project_id: "00000000-0000-4000-8000-000000000000",
          path: "a.chat",
          sender_id: "user",
          message_date: new Date().toISOString(),
          thread_id: "thread-1",
        },
      } as any),
    ).rejects.toThrow("must provide an explicit Conat client");
  });

  it("requires an explicit client for interruptAcp", async () => {
    await expect(
      interruptAcp({
        project_id: "00000000-0000-4000-8000-000000000000",
        account_id: "00000000-0000-4000-8000-000000000001",
        threadId: "thread-1",
      }),
    ).rejects.toThrow("must provide an explicit Conat client");
  });
});

describe("interruptAcp", () => {
  it("treats an empty legacy acknowledgement as queued", async () => {
    const client = {
      request: jest.fn().mockResolvedValue({ data: undefined }),
    };

    await expect(
      interruptAcp(
        {
          project_id: "00000000-0000-4000-8000-000000000000",
          account_id: "00000000-0000-4000-8000-000000000001",
          threadId: "thread-1",
        },
        client as any,
      ),
    ).resolves.toEqual({
      ok: true,
      state: "queued",
    });
  });

  it("returns the backend interrupt state", async () => {
    const client = {
      request: jest.fn().mockResolvedValue({
        data: { ok: true, state: "missing", threadId: "thread-1" },
      }),
    };

    await expect(
      interruptAcp(
        {
          project_id: "00000000-0000-4000-8000-000000000000",
          account_id: "00000000-0000-4000-8000-000000000001",
          threadId: "thread-1",
        },
        client as any,
      ),
    ).resolves.toEqual({
      ok: true,
      state: "missing",
      threadId: "thread-1",
    });
    expect(client.request).toHaveBeenCalledWith(
      "acp.project-00000000-0000-4000-8000-000000000000.account-00000000-0000-4000-8000-000000000001.interrupt",
      expect.objectContaining({
        project_id: "00000000-0000-4000-8000-000000000000",
        account_id: "00000000-0000-4000-8000-000000000001",
      }),
      { timeout: 30 * 1000 },
    );
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

describe("truncateAcpSession", () => {
  it("returns whether truncation happened", async () => {
    const client = {
      request: jest.fn().mockResolvedValue({
        data: { ok: true, truncated: true },
      }),
    };

    await expect(
      truncateAcpSession(
        {
          project_id: "00000000-0000-4000-8000-000000000000",
          account_id: "00000000-0000-4000-8000-000000000001",
          sessionId: "thr-shared-1",
          force: true,
        },
        client as any,
      ),
    ).resolves.toEqual({ ok: true, truncated: true });
  });
});
