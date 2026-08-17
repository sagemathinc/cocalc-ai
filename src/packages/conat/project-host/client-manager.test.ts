/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import type { Client } from "@cocalc/conat/core/client";

import { ProjectHostClientManager } from "./client-manager";

function client() {
  return { close: jest.fn() } as unknown as Client;
}

describe("ProjectHostClientManager", () => {
  it("reuses a healthy route and scoped token", async () => {
    const created = client();
    const api = {
      resolveHostConnection: jest.fn(async () => ({
        host_id: "host-1",
        connect_url: "https://host.example",
        host_session_id: "session-1",
      })),
      issueProjectHostAuthToken: jest.fn(async () => ({
        host_id: "host-1",
        token: "secret-token",
        expires_at: 500_000,
      })),
    };
    const createClient = jest.fn(async () => created);
    const manager = new ProjectHostClientManager({
      account_id: "account-1",
      api,
      createClient,
      now: () => 1_000,
    });

    const first = await manager.getClient({
      project_id: "project-1",
      host_id: "host-1",
    });
    const second = await manager.getClient({
      project_id: "project-1",
      host_id: "host-1",
    });

    expect(second.client).toBe(first.client);
    expect(api.issueProjectHostAuthToken).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        bearer_token: "secret-token",
        host_session_id: "session-1",
      }),
    );
  });

  it("replaces a client when the host session changes", async () => {
    let session = "session-1";
    const clients = [client(), client()];
    const api = {
      resolveHostConnection: jest.fn(async () => ({
        host_id: "host-1",
        connect_url: "https://host.example",
        host_session_id: session,
      })),
      issueProjectHostAuthToken: jest.fn(async () => ({
        host_id: "host-1",
        token: "secret-token",
        expires_at: 500_000,
      })),
    };
    const createClient = jest
      .fn()
      .mockResolvedValueOnce(clients[0])
      .mockResolvedValueOnce(clients[1]);
    const manager = new ProjectHostClientManager({
      account_id: "account-1",
      api,
      createClient,
      now: () => 1_000,
    });
    await manager.getClient({ project_id: "project-1", host_id: "host-1" });
    session = "session-2";
    const replacement = await manager.getClient({
      project_id: "project-1",
      host_id: "host-1",
    });

    expect(clients[0].close).toHaveBeenCalledTimes(1);
    expect(replacement.client).toBe(clients[1]);
  });

  it("never shares a project-scoped token between projects on one host", async () => {
    const issued = new Map<string, () => void>();
    const api = {
      resolveHostConnection: jest.fn(async () => ({
        host_id: "host-1",
        connect_url: "https://host.example",
      })),
      issueProjectHostAuthToken: jest.fn(
        ({ host_id, project_id }: { host_id: string; project_id: string }) =>
          new Promise<{
            host_id: string;
            token: string;
            expires_at: number;
          }>((resolve) => {
            issued.set(project_id, () =>
              resolve({
                host_id,
                token: `token-${project_id}`,
                expires_at: 500_000,
              }),
            );
          }),
      ),
    };
    const createClient = jest.fn(async () => client());
    const manager = new ProjectHostClientManager({
      account_id: "account-1",
      api,
      createClient,
      now: () => 1_000,
    });

    const first = manager.getClient({
      project_id: "project-1",
      host_id: "host-1",
    });
    const second = manager.getClient({
      project_id: "project-2",
      host_id: "host-1",
    });
    await Promise.resolve();
    await Promise.resolve();
    issued.get("project-2")?.();
    issued.get("project-1")?.();
    await Promise.all([first, second]);

    expect(api.issueProjectHostAuthToken).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "project-1",
        bearer_token: "token-project-1",
      }),
    );
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "project-2",
        bearer_token: "token-project-2",
      }),
    );
  });

  it("bounds the project client cache by least recent use", async () => {
    let now = 0;
    const clients = [client(), client(), client()];
    const api = {
      resolveHostConnection: jest.fn(async ({ host_id }) => ({
        host_id,
        connect_url: `https://${host_id}.example`,
      })),
      issueProjectHostAuthToken: jest.fn(async ({ host_id }) => ({
        host_id,
        token: `token-${host_id}`,
        expires_at: 500_000,
      })),
    };
    const createClient = jest
      .fn()
      .mockResolvedValueOnce(clients[0])
      .mockResolvedValueOnce(clients[1])
      .mockResolvedValueOnce(clients[2]);
    const manager = new ProjectHostClientManager({
      account_id: "account-1",
      api,
      createClient,
      maxClients: 2,
      now: () => ++now,
    });
    await manager.getClient({ project_id: "project-1", host_id: "host-1" });
    await manager.getClient({ project_id: "project-2", host_id: "host-2" });
    await manager.getClient({ project_id: "project-3", host_id: "host-3" });

    expect(clients[0].close).toHaveBeenCalledTimes(1);
    expect(clients[1].close).not.toHaveBeenCalled();
    expect(clients[2].close).not.toHaveBeenCalled();
  });

  it("backs off token issuance after a failure", async () => {
    let now = 1_000;
    const api = {
      resolveHostConnection: jest.fn(async () => ({
        host_id: "host-1",
        connect_url: "https://host.example",
      })),
      issueProjectHostAuthToken: jest
        .fn()
        .mockRejectedValueOnce(new Error("denied"))
        .mockResolvedValue({
          host_id: "host-1",
          token: "token",
          expires_at: 500_000,
        }),
    };
    const manager = new ProjectHostClientManager({
      account_id: "account-1",
      api,
      createClient: async () => client(),
      now: () => now,
      retryBackoffMs: [1_000],
    });
    await expect(
      manager.getClient({ project_id: "project-1", host_id: "host-1" }),
    ).rejects.toThrow("denied");
    await expect(
      manager.getClient({ project_id: "project-1", host_id: "host-1" }),
    ).rejects.toThrow("cooling down");
    expect(api.issueProjectHostAuthToken).toHaveBeenCalledTimes(1);
    now = 2_001;
    await manager.getClient({ project_id: "project-1", host_id: "host-1" });
    expect(api.issueProjectHostAuthToken).toHaveBeenCalledTimes(2);
  });

  it("tells the client factory when routing through the local hub proxy", async () => {
    const api = {
      resolveHostConnection: jest.fn(async () => ({
        host_id: "host-1",
        connect_url: null,
        local_proxy: true,
      })),
      issueProjectHostAuthToken: jest.fn(async () => ({
        host_id: "host-1",
        token: "token",
        expires_at: 500_000,
      })),
    };
    const createClient = jest.fn(async () => client());
    const manager = new ProjectHostClientManager({
      account_id: "account-1",
      api,
      createClient,
      resolveAddress: ({ project_id }) => `https://hub.example/${project_id}`,
      now: () => 1_000,
    });

    await manager.getClient({ project_id: "project-1", host_id: "host-1" });

    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        address: "https://hub.example/project-1",
        local_proxy: true,
      }),
    );
  });
});
