/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const localPathFileserver = jest.fn(async (opts) => ({
  ...opts,
  close: jest.fn(),
}));
const importJupyterIpynb = jest.fn(async (opts) => ({
  ipynb: opts.ipynb,
}));
const saveJupyterIpynb = jest.fn(async (opts) => ({
  ipynb: opts.ipynb,
  bytes: 10,
  converted: false,
}));

jest.mock("@cocalc/backend/conat/files/local-path", () => ({
  localPathFileserver: (...args: any[]) => localPathFileserver(...args),
}));

jest.mock("@cocalc/jupyter/ipynb/filesystem", () => ({
  importJupyterIpynb: (...args: any[]) => importJupyterIpynb(...args),
  saveJupyterIpynb: (...args: any[]) => saveJupyterIpynb(...args),
}));

jest.mock("../api/db", () => ({
  getBlob: jest.fn(),
  saveBlob: jest.fn(),
}));

const createReadServer = jest.fn(async () => undefined);

jest.mock("@cocalc/conat/files/read", () => ({
  createServer: (...args: any[]) => createReadServer(...args),
}));

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeWorkspaceFileDownloadReadServers,
  createWorkspaceJupyterFilesystemHandlers,
  ensureWorkspaceFileDownloadReadServer,
  startWorkspaceFilesystem,
  workspaceProjectFilesystem,
  WORKSPACE_FILE_DOWNLOAD_READ_SERVICE,
} from "./workspace-filesystem";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("workspace filesystem", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("starts one sandboxed multi-project service at the workspace root", async () => {
    const client = {} as any;
    await startWorkspaceFilesystem({
      client,
      path: "/tmp/workspace-projects",
    });

    expect(localPathFileserver).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        path: "/tmp/workspace-projects",
        unsafeMode: false,
        homeAliases: ["/home/user"],
        jupyter: expect.any(Object),
      }),
    );
    expect(localPathFileserver.mock.calls[0][0].project_id).toBeUndefined();
  });

  it("derives notebook ownership from the filesystem subject", async () => {
    const handlers = createWorkspaceJupyterFilesystemHandlers();
    const ipynb = { cells: [] };
    await handlers.importIpynb({
      subject: `fs.project-${PROJECT_ID}`,
      ipynb,
    });

    expect(importJupyterIpynb).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: PROJECT_ID,
        ipynb,
      }),
    );
  });

  it("rejects malformed filesystem subjects", async () => {
    const handlers = createWorkspaceJupyterFilesystemHandlers();
    await expect(
      handlers.importIpynb({
        subject: "fs.not-a-project",
        ipynb: { cells: [] },
      }),
    ).rejects.toThrow("invalid workspace filesystem subject");
  });
});

describe("workspace file download reader", () => {
  let root: string;
  let projectDir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    closeWorkspaceFileDownloadReadServers();
    root = await mkdtemp(join(tmpdir(), "workspace-reader-"));
    projectDir = join(root, PROJECT_ID);
    await mkdir(join(projectDir, "latex"), { recursive: true });
    await writeFile(join(projectDir, "latex", "tex.pdf"), "pdf");
  });

  it("resolves the canonical /home/user alias to the project directory", async () => {
    const fs = workspaceProjectFilesystem({
      project_id: PROJECT_ID,
      path: root,
    });
    expect(await fs.safeAbsPath("/home/user/latex/tex.pdf")).toBe(
      join(projectDir, "latex", "tex.pdf"),
    );
  });

  it("keeps /tmp inside the project, matching stat and archive cleanup", async () => {
    // Temporary download archives live at /tmp/.cocalc-download-archive-*, and
    // are created through this same filesystem.  Reads must land in the same
    // place rather than on the host's /tmp.
    await mkdir(join(projectDir, "tmp"), { recursive: true });
    const archive = ".cocalc-download-archive-abc.zip";
    await writeFile(join(projectDir, "tmp", archive), "zip");
    const fs = workspaceProjectFilesystem({
      project_id: PROJECT_ID,
      path: root,
    });
    expect(await fs.safeAbsPath(`/tmp/${archive}`)).toBe(
      join(projectDir, "tmp", archive),
    );
  });

  it("registers one read server per project and pairs it with the fs stat subject", async () => {
    const client = {} as any;
    const first = await ensureWorkspaceFileDownloadReadServer({
      client,
      project_id: PROJECT_ID,
      path: root,
    });
    const second = await ensureWorkspaceFileDownloadReadServer({
      client,
      project_id: PROJECT_ID,
      path: root,
    });

    expect(first.readServiceName).toBe(WORKSPACE_FILE_DOWNLOAD_READ_SERVICE);
    expect(first.statSubject).toBe(`fs.project-${PROJECT_ID}`);
    expect(second).toEqual(first);
    // Cached: the second call must not open another subscription.
    expect(createReadServer).toHaveBeenCalledTimes(1);
    expect(createReadServer).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        project_id: PROJECT_ID,
        name: WORKSPACE_FILE_DOWNLOAD_READ_SERVICE,
      }),
    );
  });

  it("streams through the sandbox without any project process running", async () => {
    const client = {} as any;
    await ensureWorkspaceFileDownloadReadServer({
      client,
      project_id: PROJECT_ID,
      path: root,
    });
    const { createReadStream } = createReadServer.mock.calls[0][0] as any;
    const stream = await createReadStream("/home/user/latex/tex.pdf");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString()).toBe("pdf");
  });
});
