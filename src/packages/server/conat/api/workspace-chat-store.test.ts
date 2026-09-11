/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { workspaceChatStoreStats } from "./workspace-chat-store";

let workspaceRuntime = true;
const getChatStoreStats = jest.fn(async (opts) => opts);
const unexpectedServiceCall = jest.fn(() => {
  throw Error("path mapping must not start a filesystem or notebook service");
});

// Keep the real sandbox path mapping, but not the unrelated service graph
// imported by workspace-filesystem. Those services have their own tests.
jest.mock("@cocalc/backend/conat/files/local-path", () => ({
  localPathFileserver: () => unexpectedServiceCall(),
}));
jest.mock("@cocalc/conat/files/read", () => ({
  createServer: () => unexpectedServiceCall(),
}));
jest.mock("@cocalc/jupyter/ipynb/filesystem", () => ({
  importJupyterIpynb: () => unexpectedServiceCall(),
  saveJupyterIpynb: () => unexpectedServiceCall(),
}));
jest.mock("@cocalc/server/conat/api/db", () => ({
  getBlob: () => unexpectedServiceCall(),
  saveBlob: () => unexpectedServiceCall(),
}));

jest.mock("@cocalc/server/launchpad/project-runtime", () => ({
  isWorkspaceProjectRuntime: () => workspaceRuntime,
}));

jest.mock("@cocalc/backend/chat-store/sqlite-offload", () => ({
  getChatStoreStats: (opts) => getChatStoreStats(opts),
}));

describe("workspace chat store", () => {
  let root: string;

  beforeEach(async () => {
    workspaceRuntime = true;
    getChatStoreStats.mockClear();
    unexpectedServiceCall.mockClear();
    root = await mkdtemp(join(tmpdir(), "cocalc-workspace-chat-"));
    process.env.COCALC_PROJECT_PATH = root;
    await mkdir(join(root, "project-1"));
  });

  afterEach(async () => {
    delete process.env.COCALC_PROJECT_PATH;
    await rm(root, { recursive: true, force: true });
    expect(unexpectedServiceCall).not.toHaveBeenCalled();
  });

  it("maps project aliases before opening the local chat store", async () => {
    await workspaceChatStoreStats({
      project_id: "project-1",
      chat_path: "/home/user/discussion.chat",
      db_path: "/home/user/.local/share/cocalc/chats.sqlite3",
    });

    expect(getChatStoreStats).toHaveBeenCalledWith({
      chat_path: join(root, "project-1", "discussion.chat"),
      db_path: join(root, "project-1", ".local/share/cocalc/chats.sqlite3"),
    });
  });

  it("keeps hosted projects on the project-host route", async () => {
    workspaceRuntime = false;

    await expect(
      workspaceChatStoreStats({
        project_id: "project-1",
        chat_path: "/home/user/discussion.chat",
      }),
    ).rejects.toThrow("call a project-host endpoint via project routing");
    expect(getChatStoreStats).not.toHaveBeenCalled();
  });
});
