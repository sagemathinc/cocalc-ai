import { acquireChatSyncDB, releaseChatSyncDB } from "@cocalc/chat/server";
import {
  collaborationIdentityNamespace,
  initializeCollaborationCopy,
} from "@cocalc/chat";
import {
  collaborationCopySourceFingerprint,
  readCollaborationSource,
} from "@cocalc/backend/collaborators/filesystem";
import { initializeCopiedCollaboration } from "./collaborators-copy";
import type { CollaborationCopy } from "@cocalc/backend/collaborators/journal";
jest.mock("@cocalc/chat/server", () => ({
  acquireChatSyncDB: jest.fn(),
  releaseChatSyncDB: jest.fn(),
}));
jest.mock("@cocalc/chat", () => ({
  collaborationCopyFingerprint: jest.fn(() => "live-fingerprint"),
  collaborationIdentityNamespace: jest.fn(),
  initializeCollaborationCopy: jest.fn(),
}));
jest.mock(
  "@cocalc/backend/collaborators/filesystem",
  () => ({
    collaborationCopySourceFingerprint: jest.fn(() => "disk-fingerprint"),
    readCollaborationSource: jest.fn(),
  }),
  { virtual: true },
);
jest.mock("./master-conat-client", () => ({
  getMasterConatClient: () => ({}),
}));
jest.mock("./sqlite/projects", () => ({
  getProject: () => ({ local_only: false }),
}));
const copy: CollaborationCopy = {
  project_id: "11111111-1111-4111-8111-111111111111",
  chat_path: "/home/user/copy.chat",
  from_path: "/home/user/original.chat",
  operation_id: "22222222-2222-4222-8222-222222222222",
  state: "ready",
  fingerprint: "disk-fingerprint",
};
const db = {},
  fs = {
    close: jest.fn(),
    lstat: jest.fn(async () => ({ isFile: () => true })),
  };
const getFilesystem = jest.fn(async () => fs as any);
beforeEach(() => {
  jest.clearAllMocks();
  (acquireChatSyncDB as jest.Mock).mockResolvedValue(db);
  (readCollaborationSource as jest.Mock).mockResolvedValue([]);
  (collaborationIdentityNamespace as jest.Mock).mockReturnValue(undefined);
  (collaborationCopySourceFingerprint as jest.Mock).mockReturnValue(
    "disk-fingerprint",
  );
});
test("confirmed copy uses live SyncDB and no direct filesystem mutation", async () => {
  await initializeCopiedCollaboration(copy, getFilesystem);
  expect(initializeCollaborationCopy).toHaveBeenCalledWith(db, {
    operation_id: copy.operation_id,
    fingerprint: "live-fingerprint",
  });
  expect(acquireChatSyncDB).toHaveBeenCalledWith(
    expect.objectContaining({
      project_id: copy.project_id,
      path: copy.chat_path,
    }),
  );
  expect(releaseChatSyncDB).toHaveBeenCalledWith(
    copy.project_id,
    copy.chat_path,
  );
  expect(fs.close).toHaveBeenCalled();
});
test("unknown outcomes and replaced destinations cannot open or mutate live chat", async () => {
  await expect(
    initializeCopiedCollaboration({ ...copy, state: "unknown" }, getFilesystem),
  ).rejects.toThrow(/reconciliation/);
  (collaborationCopySourceFingerprint as jest.Mock).mockReturnValueOnce(
    "replaced",
  );
  await expect(
    initializeCopiedCollaboration(copy, getFilesystem),
  ).rejects.toThrow(/changed/);
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
  expect(initializeCollaborationCopy).not.toHaveBeenCalled();
});
test("a deleted empty copied chat is not recreated from a cached live source", async () => {
  fs.lstat.mockRejectedValueOnce(
    Object.assign(Error("deleted"), { code: "ENOENT" }),
  );
  await expect(
    initializeCopiedCollaboration(copy, getFilesystem),
  ).rejects.toThrow(/deleted/);
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
});
test("lost namespace save acknowledgment retries same operation even though marker changed disk witness", async () => {
  (collaborationIdentityNamespace as jest.Mock).mockReturnValue(
    copy.operation_id,
  );
  (collaborationCopySourceFingerprint as jest.Mock).mockReturnValue(
    "marker-persisted",
  );
  await initializeCopiedCollaboration(copy, getFilesystem);
  expect(initializeCollaborationCopy).toHaveBeenCalledWith(
    db,
    expect.objectContaining({ operation_id: copy.operation_id }),
  );
});
test("failed live save releases the lease and retains intent for the worker to retry", async () => {
  (initializeCollaborationCopy as jest.Mock).mockRejectedValueOnce(
    Error("save failed"),
  );
  await expect(
    initializeCopiedCollaboration(copy, getFilesystem),
  ).rejects.toThrow(/save failed/);
  expect(releaseChatSyncDB).toHaveBeenCalled();
  expect(fs.close).toHaveBeenCalled();
});
