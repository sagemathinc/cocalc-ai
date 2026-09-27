import { migrateHostedChatIdentity } from "./collaborators-legacy-identity";
import { migrateLegacyChatSource } from "@cocalc/backend/collaborators/legacy-identity-source";
import { getProject } from "./sqlite/projects";
jest.mock(
  "@cocalc/backend/collaborators/legacy-identity-source",
  () => ({ migrateLegacyChatSource: jest.fn() }),
  { virtual: true },
);
jest.mock("@cocalc/conat/client", () => ({ conat: () => ({}) }));
jest.mock("./sqlite/projects", () => ({ getProject: jest.fn() }));
jest.mock("./sqlite/hosts", () => ({ getLocalHostId: () => "host" }));
jest.mock("./artifact-catalog", () => ({ withArtifactCatalog: (fs) => fs }));
jest.mock("@cocalc/backend/collaborators/filesystem", () => ({
  journalCollaborationFilesystem: (fs) => fs,
}));
jest.mock("./project-volume-lifecycle", () => ({
  withProjectVolumeLifecycleLock: async (_id, run) => run(),
  currentProjectVolumeLifecycleGeneration: () => 1,
  assertProjectVolumeLifecycleGeneration: jest.fn(),
}));
const source = {
  project_id: "11111111-1111-4111-8111-111111111111",
  chat_path: "/home/user/old.chat",
  epoch: "epoch",
} as any;
function fixture() {
  (getProject as jest.Mock).mockReturnValue({
    state: "stopped",
    local_only: false,
  });
  const fs = { close: jest.fn() };
  const options = {
    journal: {
      isEnabled: jest.fn(async () => true),
      assertSourceReady: jest.fn(),
    } as any,
    writerState: jest.fn(
      async () => ({ epoch: "epoch", writer_host_id: "host" }) as any,
    ),
    getFilesystem: jest.fn(async () => fs as any),
  };
  return { options, fs };
}
beforeEach(() => jest.clearAllMocks());
test("stopped-project migration uses an existing sandbox and current host authority", async () => {
  const f = fixture();
  await migrateHostedChatIdentity(source, f.options);
  expect(migrateLegacyChatSource).toHaveBeenCalledWith(
    expect.objectContaining({ source, fs: f.fs }),
  );
  await (migrateLegacyChatSource as jest.Mock).mock.calls[0][0].assertCurrent();
  expect(f.options.writerState).toHaveBeenCalledTimes(2);
  expect(f.fs.close).toHaveBeenCalledTimes(1);
});
test("disabled feature never acquires a filesystem", async () => {
  const f = fixture();
  f.options.journal.isEnabled.mockResolvedValue(false);
  await migrateHostedChatIdentity(source, f.options);
  expect(f.options.getFilesystem).not.toHaveBeenCalled();
});
test("stale host authority prevents identity persistence", async () => {
  const f = fixture();
  f.options.writerState.mockResolvedValue({
    epoch: "epoch",
    writer_host_id: "new-host",
  });
  await expect(migrateHostedChatIdentity(source, f.options)).rejects.toThrow(
    "authority changed",
  );
  expect(migrateLegacyChatSource).not.toHaveBeenCalled();
});
