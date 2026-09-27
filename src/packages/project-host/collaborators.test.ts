import callHub from "@cocalc/conat/hub/call-hub";
import { getProject } from "./sqlite/projects";
import { assertProjectVolumeLifecycleGeneration } from "./project-volume-lifecycle";
import { readCollaborationSource } from "@cocalc/backend/collaborators/filesystem";
import { extractCollaborationMetadata } from "@cocalc/chat";
import {
  assertArtifactCollaborationSourceReady,
  ensureUninitializedRoomParent,
  startCollaborators,
  stopCollaborators,
} from "./collaborators";

jest.mock("node:fs", () => ({ mkdirSync: jest.fn() }));
jest.mock("./collaborators-copy", () => ({
  initializeCopiedCollaboration: jest.fn(),
}));
jest.mock("./collaborators-flush", () => ({
  flushHostedCanonicalRoom: jest.fn(),
}));
jest.mock("@cocalc/backend/data", () => ({ data: "/unused" }));
jest.mock("@cocalc/backend/logger", () => () => ({ warn: jest.fn() }));
jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("./master-conat-client", () => ({
  getMasterConatClient: () => ({ connected: true }),
}));
jest.mock("./sqlite/hosts", () => ({ getLocalHostId: () => "current-host" }));
jest.mock("./sqlite/projects", () => ({
  getProject: jest.fn(),
  listProjects: () => [
    {
      project_id: "11111111-1111-4111-8111-111111111111",
      state: "stopped",
      local_only: false,
    },
  ],
}));
jest.mock("./project-volume-lifecycle", () => ({
  withProjectVolumeLifecycleLock: async (_id, run) => run(),
  currentProjectVolumeLifecycleGeneration: () => 1,
  assertProjectVolumeLifecycleGeneration: jest.fn(),
}));
jest.mock("@cocalc/chat", () => ({ extractCollaborationMetadata: jest.fn() }));
jest.mock(
  "@cocalc/backend/collaborators/filesystem",
  () => ({
    readCollaborationSource: jest.fn(),
    journalCollaborationFilesystem: jest.fn((fs) => fs),
  }),
  { virtual: true },
);
let options: any;
jest.mock(
  "@cocalc/backend/collaborators/service",
  () => ({
    CollaboratorsService: class {
      journal = {
        sources: () => [],
        isEnabled: jest.fn(async () => true),
        assertSourceReady: jest.fn(),
      };
      constructor(opts) {
        options = opts;
      }
      start() {}
      async close() {}
    },
  }),
  { virtual: true },
);
const source = {
  project_id: "11111111-1111-4111-8111-111111111111",
  chat_path: "/home/user/a.chat",
};
beforeEach(() => {
  jest.clearAllMocks();
  (getProject as jest.Mock).mockReturnValue({
    local_only: false,
    state: "stopped",
  });
  (callHub as jest.Mock).mockResolvedValue(null);
  (readCollaborationSource as jest.Mock).mockResolvedValue([]);
  (extractCollaborationMetadata as jest.Mock).mockReturnValue({
    resources: [],
    activity_ids: {},
  });
});
afterEach(async () => {
  await stopCollaborators();
});

test("metadata reads work on stopped projects through a lifecycle-locked sandbox", async () => {
  const fs = { close: jest.fn() },
    getFilesystem = jest.fn(async () => fs as any);
  startCollaborators(getFilesystem);
  expect(await options.read(source)).toEqual({
    resources: [],
    activity_ids: {},
    lifecycle_generation: 1,
  });
  expect(getFilesystem).toHaveBeenCalledWith(source.project_id);
  expect(readCollaborationSource).toHaveBeenCalledWith(fs, source.chat_path);
  expect(extractCollaborationMetadata).toHaveBeenCalledWith([], source, {
    humanRoomPath: source.chat_path,
  });
  expect(assertProjectVolumeLifecycleGeneration).toHaveBeenCalledWith(
    source.project_id,
    1,
  );
  expect(fs.close).toHaveBeenCalledTimes(1);
});
test("first room creation makes only its sandboxed parent and closes the reader", async () => {
  const fs = { mkdir: jest.fn(), close: jest.fn() };
  startCollaborators(jest.fn(async () => fs as any));
  await ensureUninitializedRoomParent({
    ...source,
    chat_path: "/home/user/.cocalc/collaborators.chat",
    room_id: "22222222-2222-4222-8222-222222222222",
  });
  expect(fs.mkdir).toHaveBeenCalledWith("/home/user/.cocalc", {
    recursive: true,
  });
  expect(assertProjectVolumeLifecycleGeneration).toHaveBeenCalledWith(
    source.project_id,
    1,
  );
  expect(fs.close).toHaveBeenCalledTimes(1);
  expect(readCollaborationSource).not.toHaveBeenCalled();
  fs.mkdir.mockRejectedValueOnce(Error("mkdir failed") as never);
  await expect(
    ensureUninitializedRoomParent({ ...source, room_id: "room" }),
  ).rejects.toThrow("mkdir failed");
  expect(fs.close).toHaveBeenCalledTimes(2);
});
test("artifact producer guard uses the retained journal fence only when enabled", async () => {
  await expect(
    assertArtifactCollaborationSourceReady(source),
  ).resolves.toBeUndefined();
  const runtime = startCollaborators(jest.fn());
  const enabled = runtime.journal.isEnabled as jest.Mock;
  const ready = runtime.journal.assertSourceReady as jest.Mock;
  ready.mockImplementation(() => {
    throw Error("identity transition pending");
  });
  await expect(assertArtifactCollaborationSourceReady(source)).rejects.toThrow(
    /pending/,
  );
  expect(ready).toHaveBeenCalledWith(source);
  ready.mockClear();
  enabled.mockResolvedValue(false);
  await expect(
    assertArtifactCollaborationSourceReady(source),
  ).resolves.toBeUndefined();
  expect(ready).not.toHaveBeenCalled();
});
test("feature settings are bounded, default off, and fail closed on refresh failure", async () => {
  const now = jest.spyOn(Date, "now").mockReturnValue(100_000);
  try {
    startCollaborators(jest.fn());
    expect(await options.enabled()).toBe(false);
    expect(callHub).toHaveBeenCalledTimes(1);
    expect(callHub).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: "system.getCustomize",
        args: [["collaborators_enabled"]],
      }),
    );
    (callHub as jest.Mock).mockResolvedValue({ collaborators_enabled: true });
    expect(await options.enabled()).toBe(false);
    expect(callHub).toHaveBeenCalledTimes(1);
    now.mockReturnValue(130_000);
    expect(await options.enabled()).toBe(true);
    (callHub as jest.Mock).mockRejectedValue(Error("settings unavailable"));
    now.mockReturnValue(160_000);
    await expect(options.enabled()).rejects.toThrow("settings unavailable");
    expect(await options.enabled()).toBe(false);
    expect(callHub).toHaveBeenCalledTimes(3);
  } finally {
    now.mockRestore();
  }
});
test("deleted or migrated projects do not recreate storage or publish removal", async () => {
  const getFilesystem = jest.fn();
  startCollaborators(getFilesystem);
  (getProject as jest.Mock).mockReturnValue(undefined);
  await expect(options.read(source)).rejects.toThrow(/locally/);
  expect(getFilesystem).not.toHaveBeenCalled();
});
test("host identity binds RPCs and recovery never replaces another same-host writer", async () => {
  startCollaborators(jest.fn());
  (callHub as jest.Mock).mockResolvedValue({
    epoch: "epoch-2",
    writer_host_id: "current-host",
  });
  expect(await options.recoverWriter(source, "epoch-1")).toBeUndefined();
  expect(callHub).toHaveBeenCalledWith(
    expect.objectContaining({
      host_id: "current-host",
      name: "collaborators.writerState",
      args: [source],
    }),
  );
  (callHub as jest.Mock).mockResolvedValue({
    epoch: "epoch-2",
    writer_host_id: "previous-host",
  });
  expect(await options.recoverWriter(source, "epoch-1")).toEqual({
    epoch: "epoch-2",
  });
  (callHub as jest.Mock).mockResolvedValue({
    epoch: "epoch-1",
    writer_host_id: "previous-host",
  });
  expect(await options.recoverWriter(source, "epoch-1")).toBeUndefined();
});
test("bounded discovery follows owner room locators without creating a default source", async () => {
  const getFilesystem = jest.fn();
  startCollaborators(getFilesystem);
  const movedRoom = {
    ...source,
    chat_path: "/home/user/moved-human-room.chat",
  };
  (callHub as jest.Mock).mockResolvedValueOnce({
    paths: [source.chat_path, movedRoom.chat_path],
  });
  expect(await options.discover()).toEqual([source, movedRoom]);
  expect(callHub).toHaveBeenLastCalledWith(
    expect.objectContaining({ name: "collaborators.sourcePage" }),
  );
  (callHub as jest.Mock).mockResolvedValueOnce({ paths: [] });
  await options.discover();
  expect(callHub).toHaveBeenLastCalledWith(
    expect.objectContaining({ name: "artifactCatalog.sourcePage" }),
  );
  expect(getFilesystem).not.toHaveBeenCalled();
});
test("activity checkpoints and relocation use host-bound owner APIs, preserving epoch and operation fencing", async () => {
  startCollaborators(jest.fn());
  const items = [
    { resource_id: "thread", kind: "conversation", activity: 100 },
  ];
  (callHub as jest.Mock).mockResolvedValue({
    epoch: "epoch",
    items,
    next: "next-page",
  });
  expect(
    await options.sourceActivity({
      ...source,
      epoch: "epoch",
      after: "previous-page",
    }),
  ).toEqual({ epoch: "epoch", resources: items, next: "next-page" });
  expect(callHub).toHaveBeenLastCalledWith(
    expect.objectContaining({
      host_id: "current-host",
      name: "collaborators.checkpointPage",
      args: [{ ...source, after: "previous-page" }],
    }),
  );
  await expect(
    options.sourceActivity({ ...source, epoch: "stale" }),
  ).rejects.toThrow(/epoch/);
  (callHub as jest.Mock).mockResolvedValue({
    epoch: "epoch",
    items: Array(51).fill(items[0]),
  });
  await expect(
    options.sourceActivity({ ...source, epoch: "epoch" }),
  ).rejects.toThrow(/checkpoint/);
  const move = {
    project_id: source.project_id,
    operation_id: "operation",
    from_chat_path: source.chat_path,
    to_chat_path: "/home/user/moved.chat",
    expected_epoch: "epoch",
    expected_destination_epoch: null,
  };
  (callHub as jest.Mock).mockResolvedValue({
    epoch: "moved-epoch",
    revision: 3,
  });
  expect(await options.relocate(move)).toEqual({
    epoch: "moved-epoch",
    revision: 3,
  });
  expect(callHub).toHaveBeenLastCalledWith(
    expect.objectContaining({
      host_id: "current-host",
      name: "collaborators.relocateSource",
      args: [move],
    }),
  );
});
